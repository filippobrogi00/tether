import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Connection, dirname, joinPosix } from './connection';
import { shellQuote } from './scan';

/**
 * Copy a local file or directory tree to an absolute remote path.
 * `remoteAbs` is the final path (basename included), not a parent folder.
 */
export async function uploadPath(conn: Connection, localAbs: string, remoteAbs: string): Promise<void> {
  const st = await fs.promises.stat(localAbs);
  if (st.isDirectory()) {
    await uploadDir(conn, localAbs, remoteAbs);
    return;
  }
  if (!st.isFile()) throw new Error(`${localAbs} is not a regular file or folder`);
  await uploadFile(conn, localAbs, remoteAbs);
}

/**
 * Copy a remote file or directory tree to an absolute local path.
 * `localAbs` is the final path (basename included), not a parent folder.
 */
export async function downloadPath(conn: Connection, remoteAbs: string, localAbs: string): Promise<void> {
  const st = await conn.stat(remoteAbs);
  if (!st) throw new Error(`${remoteAbs} does not exist on the server`);
  if (st.isDir) {
    await downloadDir(conn, remoteAbs, localAbs);
    return;
  }
  await downloadFile(conn, remoteAbs, localAbs);
}

export function sameRemoteMachine(a: Connection, b: Connection): boolean {
  return a.host.user === b.host.user && a.host.hostName === b.host.hostName && a.host.port === b.host.port;
}

/** Same-host recursive copy (`cp -a`). Fails if `to` already exists. */
export async function remoteCopy(conn: Connection, from: string, to: string): Promise<void> {
  if (await conn.stat(to)) throw new Error(`${to} already exists on the server`);
  const r = await conn.exec(`cp -a ${shellQuote(from)} ${shellQuote(to)}`);
  if (r.code !== 0) throw new Error((r.stderr || `cp failed with code ${r.code}`).trim());
}

/** Remove a remote file or directory tree (`rm -rf`). */
export async function remoteRemove(conn: Connection, remoteAbs: string): Promise<void> {
  const r = await conn.exec(`rm -rf -- ${shellQuote(remoteAbs)}`);
  if (r.code !== 0) throw new Error((r.stderr || `rm failed with code ${r.code}`).trim());
}

/** Same-host move: SFTP rename, or copy + remove if rename fails. */
export async function remoteMove(conn: Connection, from: string, to: string): Promise<void> {
  if (await conn.stat(to)) throw new Error(`${to} already exists on the server`);
  try {
    await conn.rename(from, to);
  } catch {
    await remoteCopy(conn, from, to);
    await remoteRemove(conn, from);
  }
}

/**
 * Copy or move one remote path to another (same host via shell/SFTP, else local staging).
 * `remoteTo` is the final path (basename included).
 */
export async function relayPath(
  src: Connection,
  dst: Connection,
  remoteFrom: string,
  remoteTo: string,
  mode: 'copy' | 'move',
): Promise<void> {
  if (sameRemoteMachine(src, dst)) {
    if (mode === 'copy') await remoteCopy(src, remoteFrom, remoteTo);
    else await remoteMove(src, remoteFrom, remoteTo);
    return;
  }

  if (await dst.stat(remoteTo)) throw new Error(`${remoteTo} already exists on ${dst.label}`);
  const base = remoteFrom.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? 'relay';
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tether-relay-'));
  const localAbs = path.join(tmpRoot, base);
  try {
    await downloadPath(src, remoteFrom, localAbs);
    await uploadPath(dst, localAbs, remoteTo);
    if (mode === 'move') await remoteRemove(src, remoteFrom);
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function uploadDir(conn: Connection, localAbs: string, remoteAbs: string): Promise<void> {
  await conn.mkdirp(remoteAbs);
  const entries = await fs.promises.readdir(localAbs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const from = path.join(localAbs, e.name);
    const to = joinPosix(remoteAbs, e.name);
    if (e.isDirectory()) await uploadDir(conn, from, to);
    else if (e.isFile()) await uploadFile(conn, from, to);
  }
}

async function uploadFile(conn: Connection, localAbs: string, remoteAbs: string): Promise<void> {
  await conn.mkdirp(dirname(remoteAbs));
  const tmp = tempName(remoteAbs, '/');
  try {
    await conn.put(localAbs, tmp);
    await conn.rename(tmp, remoteAbs);
  } catch (err) {
    await conn.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function downloadDir(conn: Connection, remoteAbs: string, localAbs: string): Promise<void> {
  await fs.promises.mkdir(localAbs, { recursive: true });
  const entries = await conn.readdir(remoteAbs);
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const from = joinPosix(remoteAbs, e.name);
    const to = path.join(localAbs, e.name);
    if (e.isDir) await downloadDir(conn, from, to);
    else if (e.isFile) await downloadFile(conn, from, to);
  }
}

async function downloadFile(conn: Connection, remoteAbs: string, localAbs: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(localAbs), { recursive: true });
  const tmp = tempName(localAbs, path.sep);
  try {
    await conn.get(remoteAbs, tmp);
    await fs.promises.rename(tmp, localAbs);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Hidden sibling temp file; matches TEMP_PATTERNS so scanners ignore it. */
function tempName(target: string, sep: string): string {
  const i = target.lastIndexOf(sep);
  const id = crypto.randomBytes(4).toString('hex');
  return `${target.slice(0, i + 1)}.${target.slice(i + 1)}.${id}.tether-tmp`;
}
