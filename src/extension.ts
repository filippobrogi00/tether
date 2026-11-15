import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Binding, Bindings } from './bindings';
import { Connection } from './core/connection';
import { KnownHosts } from './core/knownHosts';
import { Conflict, ConflictChoice, Logger } from './core/types';
import { VscodePrompter } from './prompter';
import { removeRemoteViewFolders, showRemoteView, TetherFileSystemProvider, TETHER_SCHEME } from './remoteFs';
import { isLocalWorkspaceFolder, Session, Shared } from './session';
import { confirmRemoteTerminals, RemoteTerminalHandle } from './terminal';
import { connectWithProgress, isEmptyDir, pickLocalDir, pickRemoteDir, pickTarget } from './wizard';

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
    'tether.openTerminal': () => withSession((s) => s.openTerminal()),
    'tether.toggleSync': () => withSession((s) => (s.state === 'paused' ? s.resume() : s.pause())),
    'tether.reconnect': () => withSession((s) => s.start(true)),
    'tether.disconnect': () => withSession((s) => s.stop()),
    'tether.remoteView': () => withSession((s) => showRemoteView(s)),
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

function startSession(folder: vscode.WorkspaceFolder, binding: Binding, mode: 'connect' | 'idle', conn?: Connection): Session {
  void dropSession(folder.uri.fsPath, false);
  const session = new Session(folder, binding, shared);
  sessions.set(folder.uri.fsPath, session);
  session.onDidChange(updateStatus);
  if (mode === 'connect') void session.start(true, conn);
  updateStatus();
  return session;
}

async function dropSession(folderPath: string, promptTerminals = true): Promise<void> {
  const session = sessions.get(folderPath);
  if (!session) return;
  if (promptTerminals) await session.promptAndCloseTerminals();
  removeRemoteViewFolders(session.binding.target);
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
      if (s.binding.target === target) return s;
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

// ---- connect flows ------------------------------------------------------------

/** Pair the folder that is already open with a folder on a server. */
async function connectFolder(): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(isLocalWorkspaceFolder);
  if (folders.length === 0) return openRemote();
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which folder?' });
  if (!folder || !isLocalWorkspaceFolder(folder)) return;

  const existing = bindings.get(folder.uri.fsPath);
  if (existing) {
    const change = 'Pair with a Different Server';
    const choice = await vscode.window.showInformationMessage(
      `This folder is already paired with ${existing.target}:${existing.remoteDir}.`,
      { modal: true },
      'Reconnect',
      change,
    );
    if (!choice) return;
    if (choice === 'Reconnect') return void startSession(folder, existing, 'connect');
    // Changing server/folder: ask about keep-alive terminals first.
    await dropSession(folder.uri.fsPath, true);
  }

  const target = await pickTarget(bindings);
  if (!target) return;
  const conn = await connectWithProgress(target, shared);
  if (!conn) return;
  const remoteDir = await pickRemoteDir(conn, path.basename(folder.uri.fsPath));
  if (!remoteDir) return conn.close();

  const remoteHasFiles = (await conn.readdir(remoteDir).catch(() => [])).length > 0;
  if (remoteHasFiles && !isEmptyDir(folder.uri.fsPath) && !(await confirmMerge(folder.uri.fsPath, `${target}:${remoteDir}`))) {
    return conn.close();
  }

  const binding = { target, remoteDir };
  await bindings.set(folder.uri.fsPath, binding);
  startSession(folder, binding, 'connect', conn);
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
    const n = s.engine?.conflicts.size ?? 0;
    if (n) items.push({ label: `$(error) Review ${n} Conflict${n > 1 ? 's' : ''}…`, run: () => resolveConflicts(s) });
    if (live) {
      items.push(
        {
          label: '$(sync) Sync Now',
          description: s.lastSync ? `last synced ${s.lastSync.toLocaleTimeString()}` : '',
          run: () => (s.state === 'paused' ? s.resume() : s.fullSync()),
        },
        { label: '$(terminal) Remote Terminal', run: () => s.openTerminal() },
        { label: '$(files) Remote View', description: 'second Explorer root for drag-and-drop', run: () => showRemoteView(s) },
        { label: '$(radio-tower) Forward a Port…', description: 'open a server port as localhost', run: () => forwardPort(s) },
        {
          label: s.state === 'paused' ? '$(debug-continue) Toggle Sync' : '$(debug-pause) Toggle Sync',
          description: s.state === 'paused' ? 'currently paused' : 'currently syncing',
          run: () => (s.state === 'paused' ? s.resume() : s.pause()),
        },
        { label: '$(debug-disconnect) Disconnect', run: () => s.stop() },
      );
    } else {
      items.push({ label: '$(plug) Reconnect to Last Used Server', description: s.detail, run: () => s.start(true) });
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(plug) Connect Another Folder…', run: openRemote },
      { label: '$(trash) Stop Syncing This Folder…', description: 'files stay on both sides', run: () => forget(s) },
    );
  }
  items.push({ label: '$(output) Show Log', run: () => channel.show() });

  const picked = await vscode.window.showQuickPick(items, {
    title: s ? `Tether: ${s.binding.target}:${s.remoteRoot || s.binding.remoteDir}` : 'Tether',
  });
  await picked?.run?.();
}

const REASONS: Record<Conflict['reason'], string> = {
  'both-changed': 'changed here and on the server',
  'both-new': 'exists on both sides with different content',
  'local-deleted-remote-changed': 'deleted here, changed on the server',
  'remote-deleted-local-changed': 'changed here, deleted on the server',
};

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
  engine: NonNullable<Session['engine']>,
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
      input2: { uri: vscode.Uri.file(serverPath), title: 'Server', description: 'Remote' },
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
        `${path.basename(rel)}: Server ↔ Mine`,
      );
    } catch {
      /* ignore */
    }
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}

async function resolveConflicts(s: Session): Promise<void> {
  const engine = s.engine;
  if (!engine) return;
  while (engine.conflicts.size > 0) {
    const list = [...engine.conflicts.values()];
    const picked =
      list.length === 1
        ? { conflict: list[0] }
        : await vscode.window.showQuickPick(
            list.map((c) => ({ label: c.path, description: REASONS[c.reason], conflict: c })),
            { title: `Tether: ${list.length} files need a decision`, placeHolder: 'Pick a file' },
          );
    if (!picked) break;
    const c = picked.conflict;
    const both = !!c.local && !!c.remote;
    const localAbs = path.join(s.localRoot, ...c.path.split('/'));
    const localUri = vscode.Uri.file(localAbs);

    // Text conflicts: open the merge editor first so the user can accept/reject regions.
    let mergeTemps: { dir: string } | undefined;
    if (both && (await isProbablyTextFile(localAbs))) {
      mergeTemps = await openConflictMergeEditor(engine, c.path, localUri);
    }

    let decided = false;
    while (!decided) {
      // After opening the merge editor, use a non-modal notification so the user can
      // still accept/reject hunks. QuickPick would steal focus and block the editor.
      let choice: ConflictChoice | undefined;
      let compare = false;
      let merge = false;

      if (mergeTemps) {
        const btn = await vscode.window.showInformationMessage(
          `${c.path}: accept or reject changes in the merge editor, then choose.`,
          'Keep my version',
          'Keep the server version',
          'Keep both',
        );
        if (btn === 'Keep my version') choice = 'local';
        else if (btn === 'Keep the server version') choice = 'remote';
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
            label: c.local ? '$(arrow-up) Keep my version' : '$(trash) Delete it on the server too',
            description: c.local ? 'replaces the copy on the server' : '',
            choice: 'local' as const,
          },
          {
            label: c.remote ? '$(arrow-down) Keep the server version' : '$(trash) Delete my copy too',
            description: c.remote ? 'replaces my copy' : '',
            choice: 'remote' as const,
          },
          ...(both ? [{ label: '$(files) Keep both', description: 'saves the server version next to mine', choice: 'both' as const }] : []),
        ];
        const action = await vscode.window.showQuickPick(actions, { title: `${c.path}: ${REASONS[c.reason]}` });
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
        mergeTemps = await openConflictMergeEditor(engine, c.path, localUri);
        if (!mergeTemps) continue;
        continue;
      }
      if (compare) {
        const tmp = path.join(os.tmpdir(), 'tether-compare', `server-${path.basename(c.path)}`);
        await engine.downloadCopy(c.path, tmp);
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tmp), localUri, `${path.basename(c.path)}: Server ↔ Mine`);
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
  s.refresh();
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
  const choice = await vscode.window.showInformationMessage(
    `Port ${input} on ${s.binding.target} is now available at ${url} (until you disconnect).`,
    'Open in Browser',
  );
  if (choice) void vscode.env.openExternal(vscode.Uri.parse(url));
}

async function forget(s: Session): Promise<void> {
  const go = 'Stop Syncing';
  const choice = await vscode.window.showWarningMessage(`Stop syncing this folder with ${s.binding.target}?`, {
    modal: true,
    detail: 'The files stay where they are, on this computer and on the server. Only the link between them is removed.',
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
  const s = current();
  status.backgroundColor = undefined;
  status.color = undefined;
  if (!s) {
    status.text = '$(plug) Tether';
    status.tooltip = 'Work on a server without installing anything on it. Click to connect.';
    return;
  }
  const where = `${s.binding.target}:${s.remoteRoot || s.binding.remoteDir}`;
  const name = s.binding.target;
  switch (s.state) {
    case 'connecting':
      status.text = `$(sync~spin) ${name}: connecting`;
      status.backgroundColor = STATUS_YELLOW;
      break;
    case 'syncing': {
      const n = s.pendingCount();
      const label = s.detail.startsWith('Syncing')
        ? s.detail.toLowerCase()
        : n > 0
          ? `syncing ${n}`
          : 'syncing';
      status.text = `$(sync~spin) ${name}: ${label}`;
      status.backgroundColor = STATUS_YELLOW;
      break;
    }
    case 'idle':
      status.text = `$(pass-filled) ${name}: in sync`;
      status.color = STATUS_GREEN;
      break;
    case 'conflicts':
      status.text = `$(error) ${name}: ${s.engine?.conflicts.size ?? 0} to review`;
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
  if (s.detail) lines.push(s.detail);
  if (s.state === 'syncing' || s.state === 'error') {
    const pending = [...s.fileStatus].filter(([, st]) => st === 'pending' || st === 'syncing').map(([p]) => p);
    const failed = [...s.fileStatus].filter(([, st]) => st === 'error').map(([p]) => p);
    if (pending.length) lines.push(`In flight (${pending.length}): ${pending.slice(0, 8).join(', ')}${pending.length > 8 ? '…' : ''}`);
    if (failed.length) lines.push(`Failed (${failed.length}): ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? '…' : ''}`);
  }
  if (s.lastSync) lines.push(`Last synced ${s.lastSync.toLocaleTimeString()}`);
  if (s.state === 'offline') lines.push('You can keep working. Changes are sent when the connection returns.');
  status.tooltip = lines.join('\n');
}
