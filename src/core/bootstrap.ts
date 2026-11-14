import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
 * Cold first sync with many one-sided files: one compressed tar instead of N SFTP puts/gets.
 * Returns true when the archive path ran successfully (caller should rescan + fill manifest).
 */
export async function tryArchiveBootstrap(
  conn: Connection,
  opts: {
    localRoot: string;
    remoteRoot: string;
    actions: Action[];
    log: Logger;
  },
): Promise<boolean> {
  const direction = bootstrapDirection(opts.actions);
  if (!direction) return false;
  const uploads = opts.actions.filter((a) => a.kind === 'upload');
  const downloads = opts.actions.filter((a) => a.kind === 'download');

  if (!(await ensureTar(conn, opts.log))) return false;

  const id = `tether-boot-${Date.now().toString(36)}`;
  const remoteArchive = `/tmp/${id}.tgz`;
  const localArchive = path.join(os.tmpdir(), `${id}.tgz`);

  try {
    if (direction === 'upload') {
      opts.log.info(`First sync: packing ${uploads.length} local files into one archive…`);
      await localTarCreate(opts.localRoot, localArchive);
      await conn.put(localArchive, remoteArchive);
      const extract = await conn.exec(
        `mkdir -p -- ${shellQuote(opts.remoteRoot)} && tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(opts.remoteRoot)} && rm -f -- ${shellQuote(remoteArchive)}`,
      );
      if (extract.code !== 0) {
        opts.log.warn(`Archive extract failed: ${extract.stderr || extract.stdout.toString()}`);
        await conn.unlink(remoteArchive).catch(() => undefined);
        return false;
      }
      opts.log.info('First sync: archive uploaded and extracted on the server.');
      return true;
    }

    opts.log.info(`First sync: packing ${downloads.length} remote files into one archive…`);
    const pack = await conn.exec(
      `tar -czf ${shellQuote(remoteArchive)} -C ${shellQuote(opts.remoteRoot)} .`,
    );
    if (pack.code !== 0) {
      opts.log.warn(`Remote archive create failed: ${pack.stderr || pack.stdout.toString()}`);
      await conn.unlink(remoteArchive).catch(() => undefined);
      return false;
    }
    await fs.promises.mkdir(opts.localRoot, { recursive: true });
    await conn.get(remoteArchive, localArchive);
    await conn.unlink(remoteArchive).catch(() => undefined);
    await localTarExtract(localArchive, opts.localRoot);
    opts.log.info('First sync: archive downloaded and extracted locally.');
    return true;
  } catch (err) {
    opts.log.warn(`Archive bootstrap failed, falling back to per-file transfer: ${(err as Error).message}`);
    await conn.unlink(remoteArchive).catch(() => undefined);
    return false;
  } finally {
    await fs.promises.rm(localArchive, { force: true }).catch(() => undefined);
  }
}

async function ensureTar(conn: Connection, log: Logger): Promise<boolean> {
  if (conn.caps.tar === undefined) {
    try {
      const r = await conn.exec('tar --version >/dev/null 2>&1 || tar -tf /dev/null >/dev/null 2>&1');
      conn.caps.tar = r.code === 0;
    } catch {
      conn.caps.tar = false;
    }
  }
  if (!conn.caps.tar) {
    log.info('Server has no usable tar; using per-file SFTP for first sync.');
    return false;
  }
  if (!(await localTarAvailable())) {
    log.info('Local tar is unavailable; using per-file SFTP for first sync.');
    return false;
  }
  return true;
}

function localTarAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('tar', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function localTarCreate(root: string, archive: string): Promise<void> {
  return runLocal(['tar', '-czf', archive, '-C', root, '.']);
}

function localTarExtract(archive: string, root: string): Promise<void> {
  return runLocal(['tar', '-xzf', archive, '-C', root]);
}

function runLocal(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${err.trim() || 'unknown error'}`));
    });
  });
}
