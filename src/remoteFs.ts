import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Connection, dirname, joinPosix } from './core/connection';
import type { Session, Shared } from './session';

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
      await conn.put(tmpLocal, tmpRemote, { stable: true });
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

/** Whether this session's Remote View root is currently in the workspace. */
export function isRemoteViewOpen(session: Session): boolean {
  const uri = remoteViewUri(session);
  return (vscode.workspace.workspaceFolders ?? []).some(
    (f) => f.uri.scheme === TETHER_SCHEME && f.uri.authority === uri.authority,
  );
}

/**
 * Toggle the Remote View workspace folder beside the local copy.
 *
 * On: VS Code turns a single-folder window into Untitled when a second root is
 * added via updateWorkspaceFolders, so we open a named .code-workspace under
 * extension storage instead.
 *
 * Off: reopen the local folder alone so the window is a normal single-folder
 * workspace again (not a leftover multi-root / named workspace).
 */
export async function toggleRemoteView(session: Session, shared: Shared): Promise<void> {
  if (isRemoteViewOpen(session)) {
    await hideRemoteView(session, shared);
    return;
  }
  await showRemoteView(session, shared);
}

/** Add the Remote View root (no-op path when already open is handled by toggle). */
export async function showRemoteView(session: Session, shared: Shared): Promise<void> {
  if (!session.conn || session.conn.closed) {
    void vscode.window.showWarningMessage('Connect to a server first, then open Remote View.');
    return;
  }
  if (isRemoteViewOpen(session)) return;

  const uri = remoteViewUri(session);
  const name = `Remote (${session.binding.target})`;
  const folders = vscode.workspace.workspaceFolders ?? [];

  const wsFile = vscode.workspace.workspaceFile;
  const needsNamedWorkspace = !wsFile || wsFile.scheme === 'untitled';
  if (needsNamedWorkspace) {
    await openNamedWorkspaceWithRemote(session, shared, uri, name);
    return;
  }

  const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name });
  if (!ok) void vscode.window.showErrorMessage('Could not add Remote View to the Explorer.');
}

/**
 * Close Remote View and restore the pre-Remote-View workspace when we own it.
 * For a user-saved multi-root workspace, only the tether: root is removed.
 */
export async function hideRemoteView(session: Session, shared: Shared): Promise<void> {
  if (isTetherManagedWorkspace(shared) || shouldRestoreSingleFolder()) {
    await shared.prompter.stashForReload();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.localRoot), false);
    return;
  }
  removeRemoteViewFolders(session.binding.target);
}

/** Directory where Tether writes temporary multi-root workspace files. */
function tetherWorkspacesDir(shared: Shared): string {
  return path.join(shared.context.globalStorageUri.fsPath, 'workspaces');
}

/** True when the current workspace file was created by Tether for Remote View. */
function isTetherManagedWorkspace(shared: Shared): boolean {
  const ws = vscode.workspace.workspaceFile;
  if (!ws || ws.scheme !== 'file') return false;
  const rel = path.relative(tetherWorkspacesDir(shared), ws.fsPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Untitled / single-local+remote windows should go back to opening the local
 * folder alone; a real saved multi-root workspace should not.
 */
function shouldRestoreSingleFolder(): boolean {
  const ws = vscode.workspace.workspaceFile;
  if (ws && ws.scheme !== 'untitled') return false;
  const locals = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme !== TETHER_SCHEME);
  return locals.length <= 1;
}

/** Write `<folderName>.code-workspace` and reopen so the window keeps that name. */
async function openNamedWorkspaceWithRemote(
  session: Session,
  shared: Shared,
  remoteUri: vscode.Uri,
  remoteName: string,
): Promise<void> {
  const locals = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme !== TETHER_SCHEME);
  const roots = locals.length > 0 ? locals : [session.folder];
  const entries: { path?: string; uri?: string; name?: string }[] = roots.map((f) =>
    f.uri.scheme === 'file' ? { path: f.uri.fsPath, name: f.name } : { uri: f.uri.toString(true), name: f.name },
  );
  entries.push({ uri: remoteUri.toString(true), name: remoteName });

  const wsDir = tetherWorkspacesDir(shared);
  await fs.promises.mkdir(wsDir, { recursive: true });
  const base = path.basename(session.localRoot).replace(/[^\w.\-]+/g, '_') || 'tether';
  const wsPath = path.join(wsDir, `${base}.code-workspace`);
  await fs.promises.writeFile(wsPath, `${JSON.stringify({ folders: entries }, null, 2)}\n`);

  await shared.prompter.stashForReload();
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsPath), false);
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
