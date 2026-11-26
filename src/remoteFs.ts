import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Connection, dirname, joinPosix } from './core/connection';
import type { RemotePeer, Session, Shared } from './session';

export const TETHER_SCHEME = 'tether';

/**
 * Native Explorer root over a session peer's remote folder.
 * Drag-and-drop / copy-paste between `file:` and `tether:` goes through these APIs.
 * URI authority is the SSH target (`encodeURIComponent`).
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
    const { conn, remotePath, session, peer } = this.resolve(uri);
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

    const rel = peer.engine?.toRel(remotePath, 'remote');
    if (rel) {
      // If a local sibling exists (DnD into Remote View from the working copy), mark both in sync.
      const localAbs = path.join(session.localRoot, ...rel.split('/'));
      if (fs.existsSync(localAbs)) await peer.engine?.noteSynced(rel);
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
    if (from.peer !== to.peer) throw vscode.FileSystemError.Unavailable('Cannot rename across servers');
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

  private resolve(uri: vscode.Uri): { session: Session; peer: RemotePeer; conn: Connection; remotePath: string } {
    if (uri.scheme !== TETHER_SCHEME) throw vscode.FileSystemError.Unavailable(uri);
    const session = this.getSession();
    if (!session) throw vscode.FileSystemError.Unavailable('Not connected to a server');
    const target = decodeURIComponent(uri.authority || '');
    const peer =
      session.peers.find((p) => p.ref.target === target) ??
      (session.binding.target === target ? session.peers[0] : undefined);
    if (!peer?.conn || peer.conn.closed || !peer.remoteRoot) {
      throw vscode.FileSystemError.Unavailable(target ? `Not connected to ${target}` : 'Not connected to a server');
    }
    const root = peer.remoteRoot.replace(/\/+$/, '') || '/';
    const rel = decodeURIComponent(uri.path).replace(/^\/+/, '');
    const remotePath = rel ? joinPosix(root, rel) : root;
    return { session, peer, conn: peer.conn, remotePath };
  }

  private fire(uri: vscode.Uri, type: vscode.FileChangeType): void {
    this.emitter.fire([{ type, uri }]);
  }
}

/** Build a `tether://` URI for one server's remote root. */
export function remoteViewUri(target: string): vscode.Uri {
  return vscode.Uri.from({ scheme: TETHER_SCHEME, authority: encodeURIComponent(target), path: '/' });
}

/** Whether a Remote View Explorer root for this SSH target is in the workspace. */
export function isRemoteViewOpenFor(target: string): boolean {
  const authority = encodeURIComponent(target);
  return (vscode.workspace.workspaceFolders ?? []).some(
    (f) => f.uri.scheme === TETHER_SCHEME && f.uri.authority === authority,
  );
}

/** Copy workspace folder state into each peer's `remoteViewActive` flag. */
export function syncRemoteViewActive(session: Session): void {
  for (const peer of session.peers) {
    peer.remoteViewActive = isRemoteViewOpenFor(peer.ref.target);
  }
}

/** True when any peer for this session has Remote View open. */
export function isRemoteViewOpen(session: Session): boolean {
  syncRemoteViewActive(session);
  return session.peers.some((p) => p.remoteViewActive);
}

/**
 * Open or close Remote View. One server: toggle. Several: pick a server;
 * already-open entries are listed as disabled (closing uses the Close section).
 */
export async function toggleRemoteView(session: Session, shared: Shared): Promise<void> {
  const peer = await pickRemoteViewPeer(session);
  if (!peer) return;
  if (peer.remoteViewActive) {
    await hideRemoteView(session, shared, peer);
    return;
  }
  await showRemoteView(session, shared, peer);
}

type RemoteViewItem = vscode.QuickPickItem & {
  peer?: RemotePeer;
  action?: 'open' | 'close';
  /** Already open: listed for context but not accepted as Open. */
  disabled?: boolean;
};

/**
 * One live peer → that peer (caller toggles). Several → picker:
 * inactive servers under Open; already-open under a disabled-looking group
 * plus an explicit Close section.
 */
async function pickRemoteViewPeer(session: Session): Promise<RemotePeer | undefined> {
  syncRemoteViewActive(session);
  const live = session.peers.filter((p) => p.conn && !p.conn.closed && p.remoteRoot);
  if (live.length === 0) {
    void vscode.window.showWarningMessage('Connect to a server first, then open Remote View.');
    return undefined;
  }
  if (live.length === 1) return live[0];

  const inactive = live.filter((p) => !p.remoteViewActive);
  const active = live.filter((p) => p.remoteViewActive);
  const items: RemoteViewItem[] = [];

  if (inactive.length) {
    items.push({ label: 'Open', kind: vscode.QuickPickItemKind.Separator });
    for (const peer of inactive) {
      items.push({
        label: `$(files) ${peer.ref.target}`,
        description: peer.remoteRoot || peer.ref.remoteDir,
        peer,
        action: 'open',
      });
    }
  }

  if (active.length) {
    items.push({ label: 'Already open', kind: vscode.QuickPickItemKind.Separator });
    for (const peer of active) {
      items.push({
        label: `$(circle-slash) ${peer.ref.target}`,
        description: 'already open',
        detail: 'Choose Close below to remove this Explorer root',
        peer,
        disabled: true,
      });
    }
    items.push({ label: 'Close', kind: vscode.QuickPickItemKind.Separator });
    for (const peer of active) {
      items.push({
        label: `$(close) ${peer.ref.target}`,
        description: 'remove from Explorer',
        peer,
        action: 'close',
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Tether: which server for Remote View?',
    placeHolder: 'Remote View',
    ignoreFocusOut: true,
  });
  if (!picked?.peer) return undefined;
  if (picked.disabled || !picked.action) {
    void vscode.window.showInformationMessage(
      `${picked.peer.ref.target} is already open in the Explorer. Use Close to remove it.`,
    );
    return undefined;
  }
  return picked.peer;
}

/** Add the Remote View root for one server. */
export async function showRemoteView(session: Session, shared: Shared, peer?: RemotePeer): Promise<void> {
  syncRemoteViewActive(session);
  const target = peer ?? session.peers.find((p) => p.conn && !p.conn.closed) ?? session.peers[0];
  if (!target?.conn || target.conn.closed || !target.remoteRoot) {
    void vscode.window.showWarningMessage('Connect to a server first, then open Remote View.');
    return;
  }
  if (target.remoteViewActive) return;

  const uri = remoteViewUri(target.ref.target);
  const name = `Remote (${target.ref.target})`;
  const folders = vscode.workspace.workspaceFolders ?? [];

  const wsFile = vscode.workspace.workspaceFile;
  const needsNamedWorkspace = !wsFile || wsFile.scheme === 'untitled';
  if (needsNamedWorkspace) {
    target.remoteViewActive = true;
    await openNamedWorkspaceWithRemotes(session, shared);
    return;
  }

  const ok = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name });
  if (!ok) {
    void vscode.window.showErrorMessage('Could not add Remote View to the Explorer.');
    return;
  }
  target.remoteViewActive = true;
}

/**
 * Close Remote View for one server. When that was the last tether root and we
 * own the workspace, restore the local folder alone.
 */
export async function hideRemoteView(session: Session, shared: Shared, peer?: RemotePeer): Promise<void> {
  syncRemoteViewActive(session);
  const target = peer ?? session.peers.find((p) => p.remoteViewActive);
  if (!target) return;

  const otherOpen = session.peers.some((p) => p !== target && p.remoteViewActive);
  target.remoteViewActive = false;

  if (!otherOpen && (isTetherManagedWorkspace(shared) || shouldRestoreSingleFolder())) {
    await shared.prompter.stashForReload();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.localRoot), false);
    return;
  }
  removeRemoteViewFolders(target.ref.target);
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

/**
 * Write `<folderName>.code-workspace` with the local roots plus every peer that
 * should show Remote View (`remoteViewActive`), then reopen.
 */
async function openNamedWorkspaceWithRemotes(session: Session, shared: Shared): Promise<void> {
  const locals = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme !== TETHER_SCHEME);
  const roots = locals.length > 0 ? locals : [session.folder];
  const entries: { path?: string; uri?: string; name?: string }[] = roots.map((f) =>
    f.uri.scheme === 'file' ? { path: f.uri.fsPath, name: f.name } : { uri: f.uri.toString(true), name: f.name },
  );
  for (const peer of session.peers) {
    if (!peer.remoteViewActive) continue;
    entries.push({
      uri: remoteViewUri(peer.ref.target).toString(true),
      name: `Remote (${peer.ref.target})`,
    });
  }

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
