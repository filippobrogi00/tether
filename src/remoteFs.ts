import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Connection, dirname, joinPosix } from './core/connection';
import type { Session } from './session';

export const TETHER_SCHEME = 'tether';

/**
 * Native Explorer root over the active session's remote folder.
 * Drag-and-drop / copy-paste between `file:` and `tether:` goes through these APIs.
 */
export class TetherFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly getSession: () => Session | undefined) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { conn, remotePath } = this.resolve(uri);
    const st = await conn.stat(remotePath);
    if (!st) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: st.isDir ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: st.mtime,
      size: st.size,
      permissions: undefined,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { conn, remotePath } = this.resolve(uri);
    const entries = await conn.readdir(remotePath);
    return entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => [e.name, e.isDir ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { conn, remotePath } = this.resolve(uri);
    await conn.mkdirp(remotePath);
    this.fire(uri, vscode.FileChangeType.Created);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { conn, remotePath } = this.resolve(uri);
    const tmp = path.join(os.tmpdir(), `tether-read-${Date.now()}-${path.basename(remotePath)}`);
    try {
      await conn.get(remotePath, tmp);
      return await fs.promises.readFile(tmp);
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const { conn, remotePath, session } = this.resolve(uri);
    const existing = await conn.stat(remotePath);
    if (!options.create && !existing) throw vscode.FileSystemError.FileNotFound(uri);
    if (!options.overwrite && existing) throw vscode.FileSystemError.FileExists(uri);
    if (existing?.isDir) throw vscode.FileSystemError.FileIsADirectory(uri);

    await conn.mkdirp(dirname(remotePath));
    const tmpLocal = path.join(os.tmpdir(), `tether-write-${Date.now()}-${path.basename(remotePath)}`);
    const tmpRemote = `${remotePath}.${Date.now().toString(36)}.tether-tmp`;
    try {
      await fs.promises.writeFile(tmpLocal, content);
      await conn.put(tmpLocal, tmpRemote);
      await conn.rename(tmpRemote, remotePath);
    } catch (err) {
      await conn.unlink(tmpRemote).catch(() => undefined);
      throw err;
    } finally {
      await fs.promises.rm(tmpLocal, { force: true }).catch(() => undefined);
    }

    const rel = session.engine?.toRel(remotePath, 'remote');
    if (rel) {
      // If a local sibling exists (DnD into Remote View from the working copy), mark both in sync.
      const localAbs = path.join(session.localRoot, ...rel.split('/'));
      if (fs.existsSync(localAbs)) await session.engine?.noteSynced(rel);
    }
    this.fire(uri, existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
    session.nudge();
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { conn, remotePath, session } = this.resolve(uri);
    const st = await conn.stat(remotePath);
    if (!st) throw vscode.FileSystemError.FileNotFound(uri);
    if (st.isDir) {
      if (!options.recursive) throw vscode.FileSystemError.Unavailable('Use recursive delete for folders');
      await this.deleteTree(conn, remotePath);
    } else {
      await conn.unlink(remotePath);
    }
    this.fire(uri, vscode.FileChangeType.Deleted);
    session.nudge();
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const from = this.resolve(oldUri);
    const to = this.resolve(newUri);
    if (from.session !== to.session) throw vscode.FileSystemError.Unavailable('Cannot rename across servers');
    const dest = await to.conn.stat(to.remotePath);
    if (dest && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
    await to.conn.mkdirp(dirname(to.remotePath));
    if (dest) await to.conn.unlink(to.remotePath).catch(() => undefined);
    await from.conn.rename(from.remotePath, to.remotePath);
    this.fire(oldUri, vscode.FileChangeType.Deleted);
    this.fire(newUri, vscode.FileChangeType.Created);
    from.session.nudge();
  }

  private async deleteTree(conn: Connection, remotePath: string): Promise<void> {
    const entries = await conn.readdir(remotePath);
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      const child = joinPosix(remotePath, e.name);
      if (e.isDir) await this.deleteTree(conn, child);
      else await conn.unlink(child);
    }
    await conn.rmdirIfEmpty(remotePath);
  }

  private resolve(uri: vscode.Uri): { session: Session; conn: Connection; remotePath: string } {
    if (uri.scheme !== TETHER_SCHEME) throw vscode.FileSystemError.Unavailable(uri);
    const session = this.getSession();
    if (!session?.conn || session.conn.closed || !session.remoteRoot) {
      throw vscode.FileSystemError.Unavailable('Not connected to a server');
    }
    const root = session.remoteRoot.replace(/\/+$/, '') || '/';
    const rel = decodeURIComponent(uri.path).replace(/^\/+/, '');
    const remotePath = rel ? joinPosix(root, rel) : root;
    return { session, conn: session.conn, remotePath };
  }

  private fire(uri: vscode.Uri, type: vscode.FileChangeType): void {
    this.emitter.fire([{ type, uri }]);
  }
}

/** Build a `tether://` URI for the session's remote root. */
export function remoteViewUri(session: Session): vscode.Uri {
  const authority = encodeURIComponent(session.binding.target);
  return vscode.Uri.from({ scheme: TETHER_SCHEME, authority, path: '/' });
}

/** Add (or focus) the Remote View workspace folder beside the local copy. */
export async function showRemoteView(session: Session): Promise<void> {
  if (!session.conn || session.conn.closed) {
    void vscode.window.showWarningMessage('Connect to a server first, then open Remote View.');
    return;
  }
  const uri = remoteViewUri(session);
  const name = `Remote (${session.binding.target})`;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const existing = folders.findIndex((f) => f.uri.scheme === TETHER_SCHEME && f.uri.authority === uri.authority);
  if (existing >= 0) {
    void vscode.window.showInformationMessage(`Remote View is already open as “${folders[existing].name}”.`);
    return;
  }
  const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name });
  if (!ok) void vscode.window.showErrorMessage('Could not add Remote View to the Explorer.');
}

/** Remove tether: workspace folders for a session that is going away. */
export function removeRemoteViewFolders(target?: string): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const toRemove: number[] = [];
  for (let i = 0; i < folders.length; i++) {
    const f = folders[i];
    if (f.uri.scheme !== TETHER_SCHEME) continue;
    if (target && decodeURIComponent(f.uri.authority) !== target) continue;
    toRemove.push(i);
  }
  // Remove from the end so indices stay valid.
  for (const i of toRemove.reverse()) {
    vscode.workspace.updateWorkspaceFolders(i, 1);
  }
}
