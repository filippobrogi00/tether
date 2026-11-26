import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  allRemotes,
  Binding,
  bindingFromRemotes,
  bindingLabel,
  Bindings,
  RemoteRef,
} from './bindings';
import { Connection, UserCancelled } from './core/connection';
import { RootSyncSelection } from './core/ignore';
import { KnownHosts } from './core/knownHosts';
import { SyncEngine } from './core/syncEngine';
import { Conflict, ConflictChoice, Logger } from './core/types';
import { VscodePrompter } from './prompter';
import {
  isRemoteViewOpen,
  removeRemoteViewFolders,
  syncRemoteViewActive,
  TetherFileSystemProvider,
  TETHER_SCHEME,
  toggleRemoteView,
} from './remoteFs';
import { isLocalWorkspaceFolder, RemotePeer, Session, Shared, SyncStrategy } from './session';
import { confirmRemoteTerminals, RemoteTerminalHandle } from './terminal';
import {
  downloadCommand,
  explorerSelection,
  relayCommand,
  relaySourcesFromExplorer,
  uploadCommand,
} from './transferCommands';
import {
  connectWithProgress,
  isEmptyDir,
  pickAddAnotherRemote,
  pickConnectMode,
  pickLocalDir,
  pickRemoteDir,
  pickRootSyncSelection,
  pickTarget,
} from './wizard';

type Item = vscode.QuickPickItem & { run?: () => unknown };

let shared: Shared;
let bindings: Bindings;
let status: vscode.StatusBarItem;
let channel: vscode.OutputChannel;
const sessions = new Map<string, Session>();
let remoteFs: TetherFileSystemProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  channel = vscode.window.createOutputChannel('Tether');
  const stamp = () => new Date().toLocaleTimeString();
  const log: Logger = {
    info: (m) => channel.appendLine(`[${stamp()}] ${m}`),
    warn: (m) => channel.appendLine(`[${stamp()}] WARNING ${m}`),
    error: (m) => channel.appendLine(`[${stamp()}] ERROR ${m}`),
  };

  const prompter = new VscodePrompter(context.secrets);
  await prompter.restoreStash();
  bindings = new Bindings(context.globalState);
  shared = {
    context,
    log,
    prompter,
    knownHosts: new KnownHosts(path.join(context.globalStorageUri.fsPath, 'known_hosts.json')),
    bindings,
  };

  remoteFs = new TetherFileSystemProvider(() => current());
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(TETHER_SCHEME, remoteFs, { isCaseSensitive: true }),
  );

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'tether.showMenu';
  status.show();

  const commands: Record<string, () => unknown> = {
    'tether.connectFolder': connectFolder,
    'tether.addRemoteServer': () => addRemoteServer(),
    'tether.openTerminal': () => withSession((s) => s.openTerminal()),
    'tether.toggleSync': () => withSession((s) => (s.state === 'paused' ? s.resume() : s.pause())),
    'tether.reconnect': () => withSession((s) => s.start(true)),
    'tether.disconnect': () => withSession((s) => s.stop()),
    'tether.remoteView': () => withSession((s) => toggleRemoteView(s, shared)),
    'tether.upload': () => withSession(uploadCommand),
    'tether.download': () => withSession(downloadCommand),
    'tether.relay': (resource?: vscode.Uri, resources?: vscode.Uri[]) => relay(resource, resources),
    'tether.openRemote': openRemote,
    'tether.showMenu': showMenu,
    'tether.showLog': () => channel.show(),
    'tether.syncNow': () => withSession((s) => (s.state === 'paused' ? s.resume() : s.fullSync())),
    'tether.resolveConflicts': () => withSession(resolveConflicts),
    'tether.forwardPort': () => withSession(forwardPort),
    'tether.forget': () => withSession(forget),
  };
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

  context.subscriptions.push(
    channel,
    status,
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) {
        if (isLocalWorkspaceFolder(f)) void dropSession(f.uri.fsPath);
      }
      for (const f of e.added) {
        if (isLocalWorkspaceFolder(f)) autoStart(f);
      }
    }),
    {
      dispose: () => {
        for (const key of [...sessions.keys()]) sessions.get(key)?.dispose();
        sessions.clear();
      },
    },
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isLocalWorkspaceFolder(folder)) autoStart(folder);
  }
  updateStatus();
}

/** Editor is closing: prompt about keep-alive terminals, then tear down SSH/sync. */
export async function deactivate(): Promise<void> {
  const handles: RemoteTerminalHandle[] = [];
  for (const session of sessions.values()) {
    handles.push(...session.remoteTerminals);
    session.remoteTerminals.length = 0;
  }
  if (handles.length) await confirmRemoteTerminals(handles);

  for (const folderPath of [...sessions.keys()]) {
    const session = sessions.get(folderPath);
    // Do not call stop() — that would clear resumeOnOpen and skip auto-connect next time.
    session?.dispose();
    sessions.delete(folderPath);
  }
}

// ---- sessions ---------------------------------------------------------------

function autoStart(folder: vscode.WorkspaceFolder): void {
  if (!isLocalWorkspaceFolder(folder)) return;
  const binding = bindings.get(folder.uri.fsPath);
  if (!binding) return;
  const auto = vscode.workspace.getConfiguration('tether', folder.uri).get('autoConnect', true);
  const resume = binding.resumeOnOpen !== false;
  const shouldConnect = auto && resume;
  const session = startSession(folder, binding, shouldConnect ? 'connect' : 'idle');
  if (!shouldConnect) {
    session.detail = resume ? 'Auto-connect is off' : 'Disconnected';
    updateStatus();
  }
}

function startSession(
  folder: vscode.WorkspaceFolder,
  binding: Binding,
  mode: 'connect' | 'idle',
  conn?: Connection | Connection[],
  strategy: SyncStrategy = 'parallel',
): Session {
  void dropSession(folder.uri.fsPath, false);
  const session = new Session(folder, binding, shared);
  sessions.set(folder.uri.fsPath, session);
  session.onDidChange(updateStatus);
  if (mode === 'connect') void session.start(true, conn, strategy);
  updateStatus();
  return session;
}

async function dropSession(folderPath: string, promptTerminals = true): Promise<void> {
  const session = sessions.get(folderPath);
  if (!session) return;
  if (promptTerminals) await session.promptAndCloseTerminals();
  for (const r of allRemotes(session.binding)) removeRemoteViewFolders(r.target);
  session.dispose();
  sessions.delete(folderPath);
  updateStatus();
}

/** The session for the file being edited, or the only/first local one. */
function current(): Session | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === TETHER_SCHEME) {
    const target = decodeURIComponent(uri.authority);
    for (const s of sessions.values()) {
      if (s.peers.some((p) => p.ref.target === target) || s.binding.target === target) return s;
    }
  }
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (folder && isLocalWorkspaceFolder(folder)) {
    const s = sessions.get(folder.uri.fsPath);
    if (s) return s;
  }
  return sessions.values().next().value;
}

async function withSession(fn: (s: Session) => unknown): Promise<void> {
  const session = current();
  if (!session) {
    const choice = await vscode.window.showInformationMessage('This window is not connected to a server yet.', 'Connect…');
    if (choice) await showMenu();
    return;
  }
  try {
    await fn(session);
  } catch (err) {
    shared.log.error((err as Error).message);
    void vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

/** Relay works with or without a live sync session (opens SSH as needed). */
async function relay(resource?: vscode.Uri, resources?: vscode.Uri[]): Promise<void> {
  try {
    const uris = explorerSelection(resource, resources);
    const fromExplorer = relaySourcesFromExplorer(uris, sessions.values());
    if (fromExplorer && !fromExplorer.ok) {
      void vscode.window.showWarningMessage(fromExplorer.reason);
      return;
    }
    await relayCommand(current(), shared, bindings, fromExplorer?.ok ? fromExplorer : undefined);
  } catch (err) {
    shared.log.error((err as Error).message);
    void vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

// ---- connect flows ------------------------------------------------------------

function withRootSelection(binding: Binding, selection: RootSyncSelection): Binding {
  const next: Binding = { ...binding };
  if (selection.exclude.length) next.rootExclude = selection.exclude;
  else delete next.rootExclude;
  if (selection.include.length) next.rootInclude = selection.include;
  else delete next.rootInclude;
  return next;
}

function pairedSummary(binding: Binding): string {
  return allRemotes(binding)
    .map((r) => `${r.target}:${r.remoteDir}`)
    .join(', ');
}

/** Pair the folder that is already open with one or more server folders. */
async function connectFolder(): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(isLocalWorkspaceFolder);
  if (folders.length === 0) return openRemote();
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which folder?' });
  if (!folder || !isLocalWorkspaceFolder(folder)) return;

  const existing = bindings.get(folder.uri.fsPath);
  let replaceExisting = false;
  if (existing) {
    const change = 'Pair with Different Server(s)';
    const choice = await vscode.window.showInformationMessage(
      `This folder is already paired with ${pairedSummary(existing)}.`,
      { modal: true },
      'Reconnect',
      change,
    );
    if (!choice) return;
    replaceExisting = choice === change;
  }

  const selection = await pickRootSyncSelection(
    folder.uri.fsPath,
    { exclude: existing?.rootExclude, include: existing?.rootInclude },
    {
      title: existing && !replaceExisting ? 'Tether: choose what to sync' : 'Tether: choose what to sync',
    },
  );
  if (!selection) return;
  if (replaceExisting) await dropSession(folder.uri.fsPath, true);

  if (existing && !replaceExisting) {
    const binding = withRootSelection(existing, selection);
    await bindings.set(folder.uri.fsPath, binding);
    return void startSession(folder, binding, 'connect', undefined, 'parallel');
  }

  const mode = await pickConnectMode();
  if (!mode) return;

  const remotes: RemoteRef[] = [];
  const conns: Connection[] = [];
  const closeAll = () => {
    for (const c of conns) c.close();
  };

  for (;;) {
    const n = remotes.length + 1;
    const target = await pickTarget(bindings, {
      title: mode === 'multi' ? `Tether: choose server ${n}` : 'Tether: choose a server',
      exclude: remotes.map((r) => r.target),
    });
    if (!target) {
      closeAll();
      return;
    }
    const conn = await connectWithProgress(target, shared);
    if (!conn) {
      closeAll();
      return;
    }
    const remoteDir = await pickRemoteDir(
      conn,
      path.basename(folder.uri.fsPath),
      `Tether: choose the folder on ${conn.label}`,
    );
    if (!remoteDir) {
      conn.close();
      closeAll();
      return;
    }

    const remoteHasFiles = (await conn.readdir(remoteDir).catch(() => [])).length > 0;
    if (
      remoteHasFiles &&
      !isEmptyDir(folder.uri.fsPath) &&
      !(await confirmMerge(folder.uri.fsPath, `${target}:${remoteDir}`))
    ) {
      conn.close();
      closeAll();
      return;
    }

    remotes.push({ target, remoteDir });
    conns.push(conn);

    if (mode === 'single') break;
    const next = await pickAddAnotherRemote(remotes.length);
    if (!next) {
      closeAll();
      return;
    }
    if (next === 'done') break;
  }

  const binding = withRootSelection(bindingFromRemotes(remotes), selection);
  await bindings.set(folder.uri.fsPath, binding);
  startSession(folder, binding, 'connect', conns, 'ordered');
}

/**
 * Pair another server with the folder that is already connected.
 * Both sides having files runs the same merge confirm as Connect Folder, then an
 * ordered reconcile so conflicts are reviewed before this server joins the others.
 */
async function addRemoteServer(session?: Session): Promise<void> {
  const run = async (s: Session): Promise<void> => {
    if (s.state === 'paused') {
      void vscode.window.showInformationMessage('Sync is paused. Resume it before adding a server.');
      return;
    }
    if (s.state === 'stopped' || s.state === 'offline' || s.state === 'connecting') {
      void vscode.window.showInformationMessage('Reconnect this folder before adding a server.');
      return;
    }
    if (s.state === 'syncing') {
      void vscode.window.showInformationMessage('Wait until the current sync finishes, then add a server.');
      return;
    }
    if (s.peers.length >= 2) {
      const go = await vscode.window.showWarningMessage(
        'Syncing more than two remote locations at once can be slow.',
        { modal: true, detail: 'Each remote syncs through this computer. Prefer two remotes when you can.' },
        'Add Another Server',
      );
      if (go !== 'Add Another Server') return;
    }

    const target = await pickTarget(bindings, {
      title: 'Tether: add a server',
      exclude: s.peers.map((p) => p.ref.target),
    });
    if (!target) return;
    if (s.peers.some((p) => p.ref.target === target)) {
      void vscode.window.showWarningMessage(`${target} is already paired with this folder.`);
      return;
    }

    const conn = await connectWithProgress(target, shared);
    if (!conn) return;
    const remoteDir = await pickRemoteDir(
      conn,
      path.basename(s.localRoot),
      `Tether: choose the folder on ${conn.label}`,
    );
    if (!remoteDir) return conn.close();

    const remoteHasFiles = (await conn.readdir(remoteDir).catch(() => [])).length > 0;
    if (
      remoteHasFiles &&
      !isEmptyDir(s.localRoot) &&
      !(await confirmMerge(s.localRoot, `${target}:${remoteDir}`))
    ) {
      return conn.close();
    }

    try {
      await s.attachRemote({ target, remoteDir }, conn);
    } catch (err) {
      if (err instanceof UserCancelled) return;
      throw err;
    }
  };

  if (!session) {
    await withSession(run);
    return;
  }
  try {
    await run(session);
  } catch (err) {
    if (err instanceof UserCancelled) return;
    shared.log.error((err as Error).message);
    void vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
  }
}

/** Start from the server: pick a remote folder, get a local working copy, open it. */
async function openRemote(): Promise<void> {
  const target = await pickTarget(bindings);
  if (!target) return;
  const conn = await connectWithProgress(target, shared);
  if (!conn) return;
  const remoteDir = await pickRemoteDir(conn, 'project');
  if (!remoteDir) return conn.close();
  const localDir = await pickLocalDir(target, remoteDir);
  if (!localDir) return conn.close();

  const known = bindings.get(localDir);
  const samePair = known?.target === target && known.remoteDir === remoteDir;
  if (!samePair && !isEmptyDir(localDir) && !(await confirmMerge(localDir, `${target}:${remoteDir}`))) {
    return conn.close();
  }

  fs.mkdirSync(localDir, { recursive: true });
  const binding = { target, remoteDir };
  await bindings.set(localDir, binding);

  const alreadyOpen = vscode.workspace.workspaceFolders?.find(
    (f) => isLocalWorkspaceFolder(f) && path.relative(f.uri.fsPath, localDir) === '',
  );
  if (alreadyOpen) return void startSession(alreadyOpen, binding, 'connect', conn);

  conn.close();
  await shared.prompter.stashForReload();
  const hasWorkspace = (vscode.workspace.workspaceFolders?.filter(isLocalWorkspaceFolder).length ?? 0) > 0;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(localDir), { forceNewWindow: hasWorkspace });
}

async function confirmMerge(localDir: string, remote: string): Promise<boolean> {
  const go = 'Merge and Connect';
  const choice = await vscode.window.showWarningMessage(
    'Both folders already contain files',
    {
      modal: true,
      detail:
        `${localDir}\nand\n${remote}\n\nTether will merge them: a file that exists on only one side is copied ` +
        `to the other, identical files are left alone, and files that differ are listed so you can choose. ` +
        `Nothing is deleted or overwritten without asking.`,
    },
    go,
  );
  return choice === go;
}

// ---- commands -----------------------------------------------------------------

async function showMenu(): Promise<void> {
  const s = current();
  const items: Item[] = [];
  if (!s) {
    items.push({ label: '$(plug) Connect Folder…', description: 'pair a folder and start two-way sync', run: connectFolder });
  } else {
    const live = s.state !== 'stopped' && s.state !== 'offline' && s.state !== 'connecting';
    const n = s.conflictCount();
    if (n) items.push({ label: `$(error) Review ${n} Conflict${n > 1 ? 's' : ''}…`, run: () => resolveConflicts(s) });
    if (live) {
      items.push(
        {
          label: '$(sync) Sync Now',
          description: s.lastSync ? `last synced ${s.lastSync.toLocaleTimeString()}` : '',
          run: () => (s.state === 'paused' ? s.resume() : s.fullSync()),
        },
        { label: '$(terminal) Remote Terminal', run: () => s.openTerminal() },
        (() => {
          syncRemoteViewActive(s);
          const openCount = s.peers.filter((p) => p.remoteViewActive).length;
          const multi = s.peers.length > 1;
          if (!multi && openCount) {
            return {
              label: '$(close) Close Remote View',
              description: 'remove the remote Explorer root and restore this folder',
              run: () => toggleRemoteView(s, shared),
            };
          }
          return {
            label: multi ? '$(files) Remote View…' : '$(files) Remote View',
            description: openCount
              ? multi
                ? `${openCount} open — choose a server`
                : 'second Explorer root for drag-and-drop'
              : multi
                ? 'choose a server for a second Explorer root'
                : 'second Explorer root for drag-and-drop',
            run: () => toggleRemoteView(s, shared),
          };
        })(),
        { label: '$(cloud-upload) Upload…', description: 'copy local files or folders to the server', run: () => uploadCommand(s) },
        { label: '$(cloud-download) Download…', description: 'copy server files or folders here', run: () => downloadCommand(s) },
        {
          label: '$(repo-forked) Relay…',
          description: 'copy or move between two remote locations',
          run: () => relay(),
        },
        { label: '$(radio-tower) Forward a Port…', description: 'open a server port as localhost', run: () => forwardPort(s) },
        {
          label: '$(add) Add Remote Server…',
          description: 'pair another server with this folder',
          run: () => addRemoteServer(s),
        },
        {
          label: s.state === 'paused' ? '$(debug-continue) Toggle Sync' : '$(debug-pause) Toggle Sync',
          description: s.state === 'paused' ? 'currently paused' : 'currently syncing',
          run: () => (s.state === 'paused' ? s.resume() : s.pause()),
        },
        { label: '$(debug-disconnect) Disconnect', run: () => s.stop() },
      );
    } else {
      items.push({
        label: '$(plug) Reconnect to Last Used Server',
        description: s.detail,
        run: () => s.start(true, undefined, 'parallel'),
      });
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(plug) Connect Another Folder…', run: openRemote },
      { label: '$(trash) Stop Syncing This Folder…', description: 'files stay on both sides', run: () => forget(s) },
    );
  }
  items.push({ label: '$(output) Show Log', run: () => channel.show() });

  const title = s
    ? `Tether: ${pairedSummary(s.binding)}`
    : 'Tether';
  const picked = await vscode.window.showQuickPick(items, { title });
  await picked?.run?.();
}

function conflictReason(reason: Conflict['reason'], server: string): string {
  const map: Record<Conflict['reason'], string> = {
    'both-changed': `changed here and on ${server}`,
    'both-new': `exists here and on ${server} with different content`,
    'local-deleted-remote-changed': `deleted here, changed on ${server}`,
    'remote-deleted-local-changed': `changed here, deleted on ${server}`,
  };
  return map[reason];
}

/** True when the file looks like text (no NUL in the first 8 KiB). */
async function isProbablyTextFile(abs: string): Promise<boolean> {
  try {
    const fd = await fs.promises.open(abs, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      return bytesRead === 0 || !buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * Open VS Code's merge editor for a text conflict (2-way: empty base).
 * Returns temp paths to clean up after the user decides, or undefined if opening failed.
 */
async function openConflictMergeEditor(
  engine: SyncEngine,
  server: string,
  rel: string,
  localUri: vscode.Uri,
): Promise<{ dir: string } | undefined> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tether-merge-'));
  const ext = path.extname(rel);
  const basePath = path.join(dir, `base${ext || '.txt'}`);
  const serverPath = path.join(dir, `server${ext || '.txt'}`);
  try {
    await fs.promises.writeFile(basePath, '');
    await engine.downloadCopy(rel, serverPath);
    const cmds = await vscode.commands.getCommands(true);
    if (!cmds.includes('_open.mergeEditor')) {
      throw new Error('_open.mergeEditor not available');
    }
    await vscode.commands.executeCommand('_open.mergeEditor', {
      base: vscode.Uri.file(basePath),
      input1: { uri: localUri, title: 'Mine', description: 'Local' },
      input2: { uri: vscode.Uri.file(serverPath), title: server, description: 'Remote' },
      output: localUri,
    });
    return { dir };
  } catch (err) {
    shared.log.warn(`merge editor unavailable (${err instanceof Error ? err.message : err}); falling back to diff`);
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(serverPath),
        localUri,
        `${path.basename(rel)}: ${server} ↔ Mine`,
      );
    } catch {
      /* ignore */
    }
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}

type ConflictBulkAction = 'all-local' | 'all-remote' | 'select-local' | 'select-remote' | 'review';

async function resolveConflicts(s: Session): Promise<void> {
  while (s.conflictCount() > 0) {
    const peer = s.peersWithConflicts()[0];
    if (!peer?.engine) break;
    s.activePeerIndex = s.peers.indexOf(peer);
    const engine = peer.engine;
    const server = peer.ref.target;
    const n = engine.conflicts.size;
    const files = n === 1 ? '1 file' : `${n} files`;
    const action = await vscode.window.showQuickPick(
      [
        {
          label: '$(arrow-up) Keep all local copies',
          description: `upload mine to ${server} for every conflict`,
          id: 'all-local' as const,
        },
        {
          label: `$(arrow-down) Keep all copies from ${server}`,
          description: 'download that server version for every conflict',
          id: 'all-remote' as const,
        },
        {
          label: '$(checklist) Select local copies to keep',
          description: 'pick which files keep my version',
          id: 'select-local' as const,
        },
        {
          label: `$(checklist) Select ${server} copies to keep`,
          description: 'pick which files keep that server version',
          id: 'select-remote' as const,
        },
        {
          label: '$(git-merge) Review manually',
          description: 'decide each file one by one',
          id: 'review' as const,
        },
      ] satisfies (vscode.QuickPickItem & { id: ConflictBulkAction })[],
      {
        title: `Tether ↔ ${server}: ${files} need a decision`,
        placeHolder: 'How do you want to resolve them?',
      },
    );
    if (!action) break;

    if (action.id === 'review') {
      await reviewConflictsManually(s, peer);
      continue;
    }

    const choice: ConflictChoice = action.id.endsWith('local') ? 'local' : 'remote';
    let paths: string[];
    if (action.id === 'all-local' || action.id === 'all-remote') {
      paths = [...engine.conflicts.keys()];
    } else {
      const selected = await pickConflictsToKeep(
        engine,
        server,
        choice === 'local' ? 'Select local copies to keep' : `Select ${server} copies to keep`,
        choice === 'local' ? 'Files that keep my version' : `Files that keep the ${server} version`,
      );
      if (!selected?.length) continue;
      paths = selected;
    }

    await applyConflictChoices(peer, paths, choice);
    s.refresh();
  }
  s.refresh();
}

async function pickConflictsToKeep(
  engine: SyncEngine,
  server: string,
  title: string,
  placeHolder: string,
): Promise<string[] | undefined> {
  const list = [...engine.conflicts.values()];
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.path, description: conflictReason(c.reason, server) })),
    { title, placeHolder, canPickMany: true },
  );
  if (!picked) return undefined;
  return picked.map((p) => p.label);
}

async function applyConflictChoices(peer: RemotePeer, paths: string[], choice: ConflictChoice): Promise<void> {
  const engine = peer.engine;
  if (!engine || paths.length === 0) return;
  const server = peer.ref.target;
  const verb = choice === 'local' ? 'Keeping local' : `Keeping ${server}`;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Tether: ${verb} copies…` },
    async (progress) => {
      const step = 100 / paths.length;
      for (const rel of paths) {
        if (!engine.conflicts.has(rel)) continue;
        progress.report({ message: rel, increment: step });
        await engine.resolveConflict(rel, choice);
      }
    },
  );
}

/** Per-file conflict review (merge editor / keep mine / keep server / keep both). */
async function reviewConflictsManually(s: Session, peer: RemotePeer): Promise<void> {
  const engine = peer.engine;
  if (!engine) return;
  const server = peer.ref.target;
  while (engine.conflicts.size > 0) {
    const list = [...engine.conflicts.values()];
    const picked =
      list.length === 1
        ? { conflict: list[0] }
        : await vscode.window.showQuickPick(
            list.map((c) => ({
              label: c.path,
              description: conflictReason(c.reason, server),
              conflict: c,
            })),
            { title: `Tether ↔ ${server}: ${list.length} files need a decision`, placeHolder: 'Pick a file' },
          );
    if (!picked) break;
    const c = picked.conflict;
    const both = !!c.local && !!c.remote;
    const localAbs = path.join(s.localRoot, ...c.path.split('/'));
    const localUri = vscode.Uri.file(localAbs);

    let mergeTemps: { dir: string } | undefined;
    if (both && (await isProbablyTextFile(localAbs))) {
      mergeTemps = await openConflictMergeEditor(engine, server, c.path, localUri);
    }

    let decided = false;
    while (!decided) {
      let choice: ConflictChoice | undefined;
      let compare = false;
      let merge = false;

      if (mergeTemps) {
        const btn = await vscode.window.showInformationMessage(
          `${c.path} (${server}): accept or reject changes in the merge editor, then choose.`,
          'Keep my version',
          `Keep ${server} version`,
          'Keep both',
        );
        if (btn === 'Keep my version') choice = 'local';
        else if (btn === `Keep ${server} version`) choice = 'remote';
        else if (btn === 'Keep both') choice = 'both';
      } else {
        const actions: (vscode.QuickPickItem & { choice?: ConflictChoice; compare?: boolean; merge?: boolean })[] = [
          ...(both
            ? [
                { label: '$(git-merge) Merge in editor…', description: 'accept or reject each change, then choose', merge: true },
                { label: '$(diff) Compare the two versions', compare: true },
              ]
            : []),
          {
            label: c.local ? '$(arrow-up) Keep my version' : `$(trash) Delete it on ${server} too`,
            description: c.local ? `replaces the copy on ${server}` : '',
            choice: 'local' as const,
          },
          {
            label: c.remote ? `$(arrow-down) Keep ${server} version` : '$(trash) Delete my copy too',
            description: c.remote ? 'replaces my copy' : '',
            choice: 'remote' as const,
          },
          ...(both
            ? [{ label: '$(files) Keep both', description: `saves the ${server} version next to mine`, choice: 'both' as const }]
            : []),
        ];
        const action = await vscode.window.showQuickPick(actions, {
          title: `${c.path}: ${conflictReason(c.reason, server)}`,
        });
        if (!action) {
          decided = true;
          if (list.length === 1) {
            s.refresh();
            return;
          }
          break;
        }
        if (action.merge) merge = true;
        else if (action.compare) compare = true;
        else choice = action.choice;
      }

      if (merge) {
        mergeTemps = await openConflictMergeEditor(engine, server, c.path, localUri);
        if (!mergeTemps) continue;
        continue;
      }
      if (compare) {
        const tmp = path.join(os.tmpdir(), 'tether-compare', `server-${path.basename(c.path)}`);
        await engine.downloadCopy(c.path, tmp);
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(tmp),
          localUri,
          `${path.basename(c.path)}: ${server} ↔ Mine`,
        );
        s.refresh();
        return;
      }
      if (!choice) {
        if (mergeTemps) await fs.promises.rm(mergeTemps.dir, { recursive: true, force: true }).catch(() => undefined);
        decided = true;
        if (list.length === 1) {
          s.refresh();
          return;
        }
        break;
      }
      await engine.resolveConflict(c.path, choice);
      if (mergeTemps) await fs.promises.rm(mergeTemps.dir, { recursive: true, force: true }).catch(() => undefined);
      decided = true;
    }
    s.refresh();
  }
}

async function forwardPort(s: Session): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Forward a port from the server',
    prompt: 'Which port is your app listening on, on the server?',
    placeHolder: '8000',
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? undefined : 'Enter a port number between 1 and 65535'),
  });
  if (!input) return;
  const local = await s.forwardPort(Number(input));
  const url = `http://localhost:${local}`;
  const host = s.forwardPeerLabel();
  const choice = await vscode.window.showInformationMessage(
    `Port ${input} on ${host} is now available at ${url} (until you disconnect).`,
    'Open in Browser',
  );
  if (choice) void vscode.env.openExternal(vscode.Uri.parse(url));
}

async function forget(s: Session): Promise<void> {
  const go = 'Stop Syncing';
  const choice = await vscode.window.showWarningMessage(`Stop syncing this folder with ${pairedSummary(s.binding)}?`, {
    modal: true,
    detail: 'The files stay where they are, on this computer and on the server(s). Only the link between them is removed.',
  }, go);
  if (choice !== go) return;
  await dropSession(s.localRoot, true);
  await bindings.delete(s.localRoot);
}

// ---- status bar ---------------------------------------------------------------

const STATUS_YELLOW = new vscode.ThemeColor('statusBarItem.warningBackground');
const STATUS_RED = new vscode.ThemeColor('statusBarItem.errorBackground');
const STATUS_GREEN = new vscode.ThemeColor('testing.iconPassed');

function updateStatus(): void {
  void vscode.commands.executeCommand('setContext', 'tether.hasSession', sessions.size > 0);
  const s = current();
  if (s) syncRemoteViewActive(s);
  status.backgroundColor = undefined;
  status.color = undefined;
  if (!s) {
    status.text = '$(plug) Tether';
    status.tooltip = 'Work on a server without installing anything on it. Click to connect.';
    return;
  }
  const where = pairedSummary(s.binding);
  const name = bindingLabel(s.binding);
  const active = s.activePeer?.ref.target;
  switch (s.state) {
    case 'connecting':
      status.text = `$(sync~spin) ${active ?? name}: connecting`;
      status.backgroundColor = STATUS_YELLOW;
      break;
    case 'syncing': {
      const n = s.pendingCount();
      const label = s.detail ? s.detail.toLowerCase() : n > 0 ? `syncing ${n}` : 'syncing';
      status.text = `$(sync~spin) ${name}: ${label}`;
      status.backgroundColor = STATUS_YELLOW;
      break;
    }
    case 'idle':
      status.text = `$(pass-filled) ${name}: in sync`;
      status.color = STATUS_GREEN;
      break;
    case 'conflicts':
      status.text = `$(error) ${active ?? name}: ${s.conflictCount()} to review`;
      status.backgroundColor = STATUS_RED;
      break;
    case 'error':
      status.text = `$(error) ${name}: sync error`;
      status.backgroundColor = STATUS_RED;
      break;
    case 'offline':
      status.text = `$(debug-disconnect) ${name}: offline`;
      status.backgroundColor = STATUS_YELLOW;
      break;
    case 'paused':
      status.text = `$(debug-pause) ${name}: paused`;
      break;
    case 'stopped':
      status.text = `$(plug) ${name}: disconnected`;
      break;
  }
  const lines = [`Tether: ${where}`];
  if (active && allRemotes(s.binding).length > 1) lines.push(`Active: ${active}`);
  if (s.detail) lines.push(s.detail);
  if (s.state === 'syncing' || s.state === 'error') {
    const syncing = [...s.fileStatus].filter(([, st]) => st === 'syncing').map(([p]) => p);
    const queued = [...s.fileStatus].filter(([, st]) => st === 'pending').map(([p]) => p);
    const failed = [...s.fileStatus].filter(([, st]) => st === 'error').map(([p]) => p);
    if (syncing.length) lines.push(`In flight (${syncing.length}): ${syncing.slice(0, 8).join(', ')}${syncing.length > 8 ? '…' : ''}`);
    if (queued.length) lines.push(`Queued (${queued.length}): ${queued.slice(0, 8).join(', ')}${queued.length > 8 ? '…' : ''}`);
    if (failed.length) lines.push(`Failed (${failed.length}): ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? '…' : ''}`);
  }
  if (s.lastSync) lines.push(`Last synced ${s.lastSync.toLocaleTimeString()}`);
  if (s.state === 'offline') lines.push('You can keep working. Changes are sent when the connection returns.');
  status.tooltip = lines.join('\n');
}
