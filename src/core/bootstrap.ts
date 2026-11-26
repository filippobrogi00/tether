import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { ClientChannel } from 'ssh2';
import { Connection } from './connection';
import { shellQuote } from './scan';
import { Action, Logger } from './types';

/** Prefer archive bootstrap when cold-start transfer count reaches this. */
export const BOOTSTRAP_MIN_FILES = 20;

export type BootstrapDirection = 'upload' | 'download';

/** Pure helper: whether a cold plan should use archive bootstrap, and which way. */
export function bootstrapDirection(actions: Action[]): BootstrapDirection | undefined {
  const uploads = actions.filter((a) => a.kind === 'upload');
  const downloads = actions.filter((a) => a.kind === 'download');
  const other = actions.filter((a) => a.kind !== 'upload' && a.kind !== 'download' && a.kind !== 'verify');
  if (uploads.length >= BOOTSTRAP_MIN_FILES && downloads.length === 0 && other.length === 0) return 'upload';
  if (downloads.length >= BOOTSTRAP_MIN_FILES && uploads.length === 0 && other.length === 0) return 'download';
  return undefined;
}

/**
 * Cold first sync with many one-sided files: one gzip stream instead of N SFTP puts/gets.
 *
 * The archive is not written to disk on either side. Local tar (gzip level 1) and the
 * remote extract share the SSH channel, so packing and unpacking overlap.
 * Returns true when that stream finished (caller should rescan the side that changed).
 */
export async function tryArchiveBootstrap(
  conn: Connection,
  opts: {
    localRoot: string;
    remoteRoot: string;
    actions: Action[];
    log: Logger;
    onDetail?: (detail: string) => void;
  },
): Promise<boolean> {
  const direction = bootstrapDirection(opts.actions);
  if (!direction) return false;
  const uploads = opts.actions.filter((a) => a.kind === 'upload');
  const downloads = opts.actions.filter((a) => a.kind === 'download');

  if (!(await ensureTar(conn, opts.log))) return false;

  try {
    if (direction === 'upload') {
      const rels = uploads.map((a) => a.path);
      opts.onDetail?.(`Copying ${rels.length} files…`);
      opts.log.info(`First sync: streaming ${rels.length} files in one archive…`);
      await streamUpload(conn, opts.localRoot, opts.remoteRoot, rels);
      opts.log.info('First sync: archive streamed and extracted on the server.');
      return true;
    }

    opts.onDetail?.(`Copying ${downloads.length} files…`);
    opts.log.info(`First sync: streaming ${downloads.length} files in one archive…`);
    await streamDownload(
      conn,
      opts.remoteRoot,
      opts.localRoot,
      downloads.map((a) => a.path),
    );
    opts.log.info('First sync: archive streamed and extracted locally.');
    return true;
  } catch (err) {
    opts.log.warn(`Archive bootstrap failed, falling back to per-file transfer: ${(err as Error).message}`);
    return false;
  }
}

async function streamUpload(conn: Connection, localRoot: string, remoteRoot: string, rels: string[]): Promise<void> {
  const channel = await conn.openExec(
    `mkdir -p -- ${shellQuote(remoteRoot)} && tar -xzf - -C ${shellQuote(remoteRoot)}`,
  );
  // tar writes errors to stderr; drain stdout so a notice cannot fill the window.
  channel.on('data', () => undefined);
  const finished = watchChannel(channel);
  void finished.catch(() => undefined);
  try {
    await pipeLocalArchive(localRoot, rels, channel);
    const result = await finished;
    if (result.code !== 0) {
      throw new Error(`Server extract failed (${result.code}): ${result.stderr || 'unknown error'}`);
    }
  } catch (err) {
    channel.destroy();
    throw err;
  }
}

async function streamDownload(conn: Connection, remoteRoot: string, localRoot: string, rels: string[]): Promise<void> {
  await fs.promises.mkdir(localRoot, { recursive: true });
  const channel = await conn.openExec(remotePackCommand(remoteRoot, conn.caps.tarBsd === true));
  const finished = watchChannel(channel);
  void finished.catch(() => undefined);
  const extract = startLocalExtract(localRoot);
  try {
    await Promise.all([writeAll(channel, memberList(rels)), pipeInto(channel, extract.stdin)]);
    const code = await extract.done;
    const remote = await finished;
    if (code !== 0) throw new Error(`Local extract failed (${code}): ${extract.stderr() || 'unknown error'}`);
    if (remote.code !== 0) throw new Error(`Server archive failed (${remote.code}): ${remote.stderr || 'unknown error'}`);
  } catch (err) {
    channel.destroy();
    extract.kill();
    throw err;
  }
}

function remotePackCommand(remoteRoot: string, bsd: boolean): string {
  // GNU tar honors GZIP=-1. bsdtar compresses with zlib and needs --options;
  // that flag is an error on GNU tar, so the two builds stay on separate commands.
  // COPYFILE_DISABLE stops macOS tar from inventing AppleDouble `._` members.
  const level = bsd ? '--options gzip:compression-level=1 ' : '';
  const env = bsd ? 'env COPYFILE_DISABLE=1 ' : 'env GZIP=-1 COPYFILE_DISABLE=1 ';
  return `${env}tar -C ${shellQuote(remoteRoot)} --null ${level}-czf - -T -`;
}

async function ensureTar(conn: Connection, log: Logger): Promise<boolean> {
  const localKind = probeLocalTar();
  if (conn.caps.tar === undefined) {
    try {
      const r = await conn.exec('tar --version 2>&1');
      const text = `${r.stdout.toString()}\n${r.stderr}`;
      if (r.code === 0) {
        conn.caps.tar = true;
        conn.caps.tarBsd = /bsdtar|libarchive/i.test(text);
      } else {
        const again = await conn.exec('tar -tf /dev/null >/dev/null 2>&1');
        conn.caps.tar = again.code === 0;
        conn.caps.tarBsd = false;
      }
    } catch {
      conn.caps.tar = false;
    }
  }
  if (!conn.caps.tar) {
    log.info('Server has no usable tar; using per-file SFTP for first sync.');
    return false;
  }
  if ((await localKind) === 'none') {
    log.info('Local tar is unavailable; using per-file SFTP for first sync.');
    return false;
  }
  return true;
}

type LocalTarKind = 'bsd' | 'gnu' | 'none';

let localTarKind: Promise<LocalTarKind> | undefined;

function probeLocalTar(): Promise<LocalTarKind> {
  if (!localTarKind) {
    localTarKind = new Promise((resolve) => {
      const child = spawn('tar', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', () => resolve('none'));
      child.on('close', (code) => {
        if (code !== 0) resolve('none');
        else resolve(/bsdtar|libarchive/i.test(out) ? 'bsd' : 'gnu');
      });
    });
  }
  return localTarKind;
}

/**
 * Pack only `rels` (POSIX paths relative to `root`). Tar of the whole directory
 * would also ship ignored trees such as `.git/` and anything created while the
 * archive was being built.
 */
export function packLocalArchive(root: string, archive: string, rels: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(archive);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    pipeLocalArchive(root, rels, out).catch(fail);
  });
}

/** NUL-separated `./rel` list so names like `-rf` stay filenames. */
function memberList(rels: string[]): Buffer {
  return Buffer.from(rels.map((rel) => `./${rel}`).join('\0') + '\0');
}

/**
 * Stream a gzip-level-1 tar of `rels` into `dest`, then end `dest`.
 * Level 1 is several times faster than tar's default and still shrinks source trees.
 */
async function pipeLocalArchive(root: string, rels: string[], dest: Writable): Promise<void> {
  const kind = await probeLocalTar();
  if (kind === 'none') throw new Error('tar failed to start');
  const args = ['--null'];
  if (kind === 'bsd') args.push('--options', 'gzip:compression-level=1');
  args.push('-czf', '-', '-T', '-');
  const env: NodeJS.ProcessEnv = { ...process.env, COPYFILE_DISABLE: '1' };
  if (kind === 'gnu') env.GZIP = '-1';
  const tar = spawn('tar', args, {
    cwd: path.resolve(root),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = collect(tar.stderr);
  const exited = waitExit(tar);
  let code: number | null = null;
  try {
    const outcome = await Promise.all([exited, writeAll(tar.stdin!, memberList(rels)), pipeInto(tar.stdout!, dest, false)]);
    code = outcome[0];
  } finally {
    if (tar.exitCode === null && !tar.killed) {
      try {
        tar.kill();
      } catch {
        /* already gone */
      }
    }
  }
  if (code !== 0) {
    dest.destroy();
    throw new Error(`tar failed (exit ${code}): ${stderr() || 'unknown error'}`);
  }
  dest.end();
}

function startLocalExtract(root: string): {
  stdin: Writable;
  done: Promise<number | null>;
  stderr: () => string;
  kill: () => void;
} {
  const tar = spawn('tar', ['-xzf', '-', '-C', root], { stdio: ['pipe', 'ignore', 'pipe'] });
  return {
    stdin: tar.stdin!,
    done: waitExit(tar),
    stderr: collect(tar.stderr),
    kill: () => {
      if (tar.exitCode === null && !tar.killed) {
        try {
          tar.kill();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

function watchChannel(stream: ClientChannel): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr: stderr.trim() });
    };
    stream.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    stream.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    stream.on('close', (code: number | null) => finish(code ?? null));
  });
}

function collect(stream: Readable | null): () => string {
  let text = '';
  stream?.on('data', (d: Buffer) => {
    text += d.toString();
    if (text.length > 8000) text = text.slice(-8000);
  });
  return () => text.trim();
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

function writeAll(dest: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let off = 0;
    const fail = (err: Error) => reject(err);
    dest.on('error', fail);
    const step = (): void => {
      let ok = true;
      while (ok && off < buf.length) {
        const end = Math.min(buf.length, off + 64 * 1024);
        ok = dest.write(buf.subarray(off, end));
        off = end;
      }
      if (off < buf.length) dest.once('drain', step);
      else {
        dest.end();
        dest.off('error', fail);
        resolve();
      }
    };
    step();
  });
}

/** Copy `src` into `dest`. When `end` is true, end `dest` after the last byte. */
function pipeInto(src: Readable, dest: Writable, end = true): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let blocked = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const finish = (): void => {
      if (settled) return;
      if (blocked) {
        dest.once('drain', () => {
          blocked = false;
          finish();
        });
        return;
      }
      settled = true;
      if (end) dest.end();
      resolve();
    };
    src.on('error', fail);
    dest.on('error', fail);
    src.on('data', (chunk: Buffer) => {
      blocked = !dest.write(chunk);
      if (blocked) src.pause();
    });
    dest.on('drain', () => {
      blocked = false;
      src.resume();
    });
    src.on('end', finish);
    src.on('close', () => finish());
  });
}
