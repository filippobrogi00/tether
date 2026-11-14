import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Bindings } from './bindings';
import { Connection, UserCancelled, joinPosix } from './core/connection';
import { listConfiguredHosts, parseTarget } from './core/sshConfig';
import { Shared } from './session';

type Item = vscode.QuickPickItem & { value?: string; action?: string };

/** Step 1: which server? Lists hosts from ~/.ssh/config and recent ones; typing a new one is one step. */
export async function pickTarget(bindings: Bindings): Promise<string | undefined> {
  const recent = bindings.recentTargets();
  const configured = listConfiguredHosts().filter((h) => !recent.includes(h));
  const items: Item[] = [
    ...recent.map((h) => ({ label: `$(history) ${h}`, description: 'recently used', value: h })),
    ...configured.map((h) => ({ label: `$(server) ${h}`, description: 'from your SSH config', value: h })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add a new server…', action: 'new' },
  ];

  const picked =
    recent.length + configured.length === 0
      ? items[items.length - 1]
      : await vscode.window.showQuickPick(items, { title: 'Tether (1/2): choose a server', placeHolder: 'Which server?' });
  if (!picked) return undefined;
  if (picked.value) return picked.value;

  return vscode.window.showInputBox({
    title: 'Tether: add a server',
    prompt: 'Type the address you would use with ssh.',
    placeHolder: 'user@hostname   (add :port if it is not 22)',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return 'Enter an address like alice@server.example.com';
      if (/\s/.test(t)) return 'An address cannot contain spaces. Example: alice@server.example.com';
      return parseTarget(t).host ? undefined : 'That does not look like a server address.';
    },
  }).then((v) => v?.trim());
}

export async function connectWithProgress(target: string, shared: Shared): Promise<Connection | undefined> {
  try {
    const conn = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${target}…` },
      () => Connection.open(target, { prompter: shared.prompter, log: shared.log, knownHosts: shared.knownHosts }),
    );
    void shared.prompter.offerToSave();
    return conn;
  } catch (err) {
    if (!(err instanceof UserCancelled)) {
      shared.log.error((err as Error).message);
      void vscode.window.showErrorMessage(`Tether: ${(err as Error).message}`);
    }
    return undefined;
  }
}

/** Step 2: which folder on the server? A click-through browser, so nobody has to know a path by heart. */
export async function pickRemoteDir(conn: Connection, suggestedName: string): Promise<string | undefined> {
  let current = conn.home;
  for (;;) {
    let dirs: string[] = [];
    try {
      dirs = (await conn.readdir(current))
        .filter((e) => e.isDir)
        .map((e) => e.name)
        .sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b));
    } catch {
      void vscode.window.showWarningMessage(`Cannot open ${current} on the server.`);
      if (current === conn.home) return undefined;
      current = conn.home;
      continue;
    }
    const items: Item[] = [
      { label: '$(check) Use this folder', description: current, action: 'use' },
      { label: '$(new-folder) Create a new folder here…', action: 'new' },
      { label: '$(edit) Type a path…', action: 'type' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...(current !== '/' ? [{ label: '$(arrow-up) ..', description: 'parent folder', action: 'up' }] : []),
      ...dirs.map((d) => ({ label: `$(folder) ${d}`, value: d })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Tether (2/2): choose the folder on ${conn.label}`,
      placeHolder: current,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.value) {
      current = joinPosix(current, picked.value);
    } else if (picked.action === 'up') {
      current = current.slice(0, current.lastIndexOf('/')) || '/';
    } else if (picked.action === 'use') {
      return current;
    } else if (picked.action === 'new') {
      const name = await vscode.window.showInputBox({
        title: `New folder in ${current}`,
        value: suggestedName,
        validateInput: (v) => (!v.trim() || /\//.test(v) ? 'Enter a folder name without "/"' : undefined),
      });
      if (name) {
        const dir = joinPosix(current, name.trim());
        try {
          await conn.mkdirp(dir);
          return dir;
        } catch (err) {
          void vscode.window.showErrorMessage(`Could not create ${dir}: ${(err as Error).message}`);
        }
      }
    } else if (picked.action === 'type') {
      const typed = await vscode.window.showInputBox({ title: 'Folder on the server', value: current + '/' });
      if (typed?.trim()) return conn.resolvePath(typed.trim());
    }
  }
}

/** For "open from server": where should the local working copy live? */
export async function pickLocalDir(target: string, remoteDir: string): Promise<string | undefined> {
  const hostPart = (parseTarget(target).host || target).replace(/[^\w.-]+/g, '_');
  const name = remoteDir.split('/').filter(Boolean).pop() ?? 'home';
  const suggested = path.join(os.homedir(), 'Tether', hostPart, name);
  const picked = await vscode.window.showQuickPick<Item>(
    [
      { label: '$(check) Use the suggested location', description: suggested, action: 'default' },
      { label: '$(folder-opened) Choose another location…', action: 'choose' },
    ],
    { title: 'Where should the working copy live on this computer?', ignoreFocusOut: true },
  );
  if (!picked) return undefined;
  if (picked.action === 'default') return suggested;

  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use This Folder',
  });
  if (!chosen?.[0]) return undefined;
  const dir = chosen[0].fsPath;
  // An empty folder is used as-is; otherwise make a subfolder so nothing existing gets mixed in.
  return isEmptyDir(dir) ? dir : path.join(dir, name);
}

export function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0;
  } catch {
    return true; // does not exist yet
  }
}
