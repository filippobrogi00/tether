import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { Connection } from './connection';
import { shellQuote } from './scan';
import { Logger } from './types';

/** Compress when the file is at least this many bytes (small files are RTT-bound). */
export const COMPRESS_MIN_BYTES = 8 * 1024;

export async function probeGzip(conn: Connection): Promise<boolean> {
  if (conn.caps.gzip !== undefined) return conn.caps.gzip;
  try {
    const r = await conn.exec('gzip -V >/dev/null 2>&1 || gzip -h >/dev/null 2>&1');
    return (conn.caps.gzip = r.code === 0);
  } catch {
    return (conn.caps.gzip = false);
  }
}

export async function probeRsync(conn: Connection): Promise<boolean> {
  if (conn.caps.rsync !== undefined) return conn.caps.rsync;
  try {
    const remote = await conn.exec('command -v rsync >/dev/null 2>&1');
    if (remote.code !== 0) return (conn.caps.rsync = false);
  } catch {
    return (conn.caps.rsync = false);
  }
  const local = await new Promise<boolean>((resolve) => {
    const child = spawn('rsync', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return (conn.caps.rsync = local);
}

/**
 * Upload via gzip when worthwhile; otherwise caller should use plain SFTP put.
 * Writes to a remote temp path that must still be renamed into place by the caller.
 */
export async function putCompressed(
  conn: Connection,
  localAbs: string,
  remoteTmp: string,
  size: number,
  log: Logger,
): Promise<boolean> {
  if (size < COMPRESS_MIN_BYTES || !(await probeGzip(conn))) return false;
  const gzLocal = path.join(os.tmpdir(), `tether-${path.basename(localAbs)}.${Date.now()}.gz`);
  const gzRemote = `${remoteTmp}.gz`;
  try {
    await gzipFile(localAbs, gzLocal);
    await conn.put(gzLocal, gzRemote, { stable: true });
    const r = await conn.exec(
      `gzip -dc -- ${shellQuote(gzRemote)} > ${shellQuote(remoteTmp)} && rm -f -- ${shellQuote(gzRemote)}`,
    );
    if (r.code !== 0) {
      log.warn(`gzip upload decode failed for ${path.basename(localAbs)}: ${r.stderr}`);
      await conn.unlink(gzRemote).catch(() => undefined);
      await conn.unlink(remoteTmp).catch(() => undefined);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`Compressed upload failed, using plain SFTP: ${(err as Error).message}`);
    await conn.unlink(gzRemote).catch(() => undefined);
    return false;
  } finally {
    await fs.promises.rm(gzLocal, { force: true }).catch(() => undefined);
  }
}

/**
 * Download via remote gzip when worthwhile; writes the decompressed file to localTmp.
 */
export async function getCompressed(
  conn: Connection,
  remoteAbs: string,
  localTmp: string,
  size: number,
  log: Logger,
): Promise<boolean> {
  if (size < COMPRESS_MIN_BYTES || !(await probeGzip(conn))) return false;
  const id = `tether-dl-${Date.now().toString(36)}`;
  const gzRemote = `/tmp/${id}.gz`;
  const gzLocal = path.join(os.tmpdir(), `${id}.gz`);
  try {
    const pack = await conn.exec(`gzip -c -- ${shellQuote(remoteAbs)} > ${shellQuote(gzRemote)}`);
    if (pack.code !== 0) {
      await conn.unlink(gzRemote).catch(() => undefined);
      return false;
    }
    await conn.get(gzRemote, gzLocal);
    await conn.unlink(gzRemote).catch(() => undefined);
    await gunzipFile(gzLocal, localTmp);
    return true;
  } catch (err) {
    log.warn(`Compressed download failed, using plain SFTP: ${(err as Error).message}`);
    await conn.unlink(gzRemote).catch(() => undefined);
    return false;
  } finally {
    await fs.promises.rm(gzLocal, { force: true }).catch(() => undefined);
  }
}

/**
 * Optional rsync fast path for one path (POSIX). Returns true on success.
 * Uses the system `ssh` binary and the host alias from the binding target when possible.
 * Each call is a new SSH login, so it is only a win for a large file that already
 * exists on the other side (a delta). New and small files are faster over the open SFTP session.
 */
export async function rsyncPath(
  conn: Connection,
  direction: 'upload' | 'download',
  localAbs: string,
  remoteAbs: string,
  sshTarget: string,
  log: Logger,
): Promise<boolean> {
  if (!(await probeRsync(conn))) return false;
  const remoteSpec = `${sshTarget}:${remoteAbs}`;
  const args =
    direction === 'upload'
      ? ['-az', '--', localAbs, remoteSpec]
      : ['-az', '--', remoteSpec, localAbs];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('rsync', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `rsync exit ${code}`))));
    });
    return true;
  } catch (err) {
    log.warn(`rsync ${direction} failed for ${path.basename(localAbs)}: ${(err as Error).message}`);
    return false;
  }
}

function gzipFile(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const inp = fs.createReadStream(src);
    const out = fs.createWriteStream(dest);
    const gz = zlib.createGzip({ level: 6 });
    inp.on('error', reject);
    out.on('error', reject);
    gz.on('error', reject);
    out.on('finish', () => resolve());
    inp.pipe(gz).pipe(out);
  });
}

function gunzipFile(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const inp = fs.createReadStream(src);
    const out = fs.createWriteStream(dest);
    const gz = zlib.createGunzip();
    inp.on('error', reject);
    out.on('error', reject);
    gz.on('error', reject);
    out.on('finish', () => resolve());
    inp.pipe(gz).pipe(out);
  });
}
