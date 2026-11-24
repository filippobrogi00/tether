import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Bindings } from './bindings';
import { Connection, UserCancelled, joinPosix } from './core/connection';
import {
  DEFAULT_IGNORES,
  IgnoreRules,
  initialSyncPicks,
  LocalEntry,
  RootSyncFilter,
  RootSyncSelection,
  selectionFromPicks,
} from './core/ignore';
import { listConfiguredHosts, parseTarget } from './core/sshConfig';
import { Shared } from './session';

type Item = vscode.QuickPickItem & { value?: string; action?: string };

export type PickTargetOptions = {
  title?: string;
  /** When set, listed first as “current session” (Relay source). */
  preferred?: string;
};

/** Step 1: which server? Lists hosts from ~/.ssh/config and recent ones; typing a new one is one step. */
export async function pickTarget(bindings: Bindings, options?: PickTargetOptions): Promise<string | undefined> {
  const preferred = options?.preferred?.trim() || undefined;
  const recent = bindings.recentTargets().filter((h) => h !== preferred);
  const configured = listConfiguredHosts().filter((h) => h !== preferred && !recent.includes(h));
  const items: Item[] = [
    ...(preferred ? [{ label: `$(server) ${preferred}`, description: 'current session', value: preferred }] : []),
    ...recent.map((h) => ({ label: `$(history) ${h}`, description: 'recently used', value: h })),
    ...configured.map((h) => ({ label: `$(server) ${h}`, description: 'from your SSH config', value: h })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add a new server…', action: 'new' },
  ];

  const title = options?.title ?? 'Tether (1/2): choose a server';
  const picked =
    !preferred && recent.length + configured.length === 0
      ? items[items.length - 1]
      : await vscode.window.showQuickPick(items, { title, placeHolder: 'Which server?', ignoreFocusOut: true });
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

export type RemotePick = { path: string; isDir: boolean };

export type PickRemoteOptions = {
  title: string;
  /** When true, files can be selected (download). Destination pickers leave this false. */
  allowFiles?: boolean;
  suggestedName?: string;
  startAt?: string;
  typePrompt?: string;
};

/** Step 2: which folder on the server? A click-through browser, so nobody has to know a path by heart. */
export async function pickRemoteDir(conn: Connection, suggestedName: string, title?: string): Promise<string | undefined> {
  const picked = await pickRemotePath(conn, {
    title: title ?? `Tether (2/2): choose the folder on ${conn.label}`,
    suggestedName,
    typePrompt: 'Folder on the server',
  });
  return picked?.path;
}

type SyncItem = vscode.QuickPickItem & { name?: string };

function compareEntries(a: LocalEntry, b: LocalEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  const ad = a.name.startsWith('.') ? 1 : 0;
  const bd = b.name.startsWith('.') ? 1 : 0;
  if (ad !== bd) return ad - bd;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Checkboxes for the top-level files and folders of `localRoot`.
 * Checked items are synced. Build output, caches, and `.git` start unchecked.
 * Cancel returns undefined. An empty folder returns an empty selection without a prompt.
 */
export async function pickRootSyncSelection(
  localRoot: string,
  previous?: RootSyncFilter,
  options?: { title?: string },
): Promise<RootSyncSelection | undefined> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(localRoot, { withFileTypes: true });
  } catch (err) {
    void vscode.window.showErrorMessage(`Tether: cannot read ${localRoot}: ${(err as Error).message}`);
    return undefined;
  }
  const entries: LocalEntry[] = dirents.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  if (entries.length === 0) return { exclude: [], include: [] };

  const cfg = vscode.workspace.getConfiguration('tether', vscode.Uri.file(localRoot));
  const baseline = IgnoreRules.load(
    localRoot,
    cfg.get<string[]>('ignore', DEFAULT_IGNORES),
    cfg.get<boolean>('respectGitignore', false),
  );
  const picked = new Set(initialSyncPicks(entries, baseline, previous));
  const unchecked: SyncItem[] = [];
  const checked: SyncItem[] = [];
  for (const entry of [...entries].sort(compareEntries)) {
    const on = picked.has(entry.name);
    const item: SyncItem = {
      label: `${entry.isDir ? '$(folder)' : '$(file)'} ${entry.name}`,
      name: entry.name,
      description: on ? undefined : entry.isDir && entry.name === '.git' ? 'never synced' : 'not synced unless you check it',
    };
    (on ? checked : unchecked).push(item);
  }
  const items: SyncItem[] = [...unchecked];
  if (unchecked.length && checked.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push(...checked);

  const chosen = await new Promise<readonly SyncItem[] | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<SyncItem>();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    qp.title = options?.title ?? 'Tether: choose what to sync';
    qp.placeholder = 'Checked items are synced. Uncheck anything that should stay on this computer, then press Enter.';
    qp.items = items;
    qp.selectedItems = checked;
    let settled = false;
    const finish = (value: readonly SyncItem[] | undefined) => {
      if (settled) return;
      settled = true;
      qp.hide();
      qp.dispose();
      resolve(value);
    };
    qp.onDidAccept(() => finish(qp.selectedItems));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
  if (!chosen) return undefined;
  return selectionFromPicks(
    entries,
    chosen.map((item) => item.name).filter((name): name is string => !!name),
    baseline,
  );
}

/**
 * Click-through remote browser. Folders navigate; "Use this folder" selects the current dir.
 * When `allowFiles` is set, choosing a file returns it immediately.
 */
export async function pickRemotePath(conn: Connection, options: PickRemoteOptions): Promise<RemotePick | undefined> {
  const allowFiles = options.allowFiles === true;
  let current = options.startAt ? conn.resolvePath(options.startAt) : conn.home;
  for (;;) {
    let dirs: string[] = [];
    let files: string[] = [];
    try {
      const entries = await conn.readdir(current);
      const sortName = (a: string, b: string) =>
        Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b);
      dirs = entries
        .filter((e) => e.isDir)
        .map((e) => e.name)
        .sort(sortName);
      if (allowFiles) {
        files = entries
          .filter((e) => e.isFile)
          .map((e) => e.name)
          .sort(sortName);
      }
    } catch {
      void vscode.window.showWarningMessage(`Cannot open ${current} on the server.`);
      if (current === '/' || current === conn.home) return undefined;
      current = conn.home;
      continue;
    }
    const items: Item[] = [
      {
        label: allowFiles ? '$(check) Select this folder' : '$(check) Use this folder',
        description: current,
        action: 'use',
      },
      { label: '$(new-folder) Create a new folder here…', action: 'new' },
      { label: '$(edit) Type a path…', action: 'type' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...(current !== '/' ? [{ label: '$(arrow-up) ..', description: 'parent folder', action: 'up' }] : []),
      ...dirs.map((d) => ({ label: `$(folder) ${d}`, value: d, action: 'dir' })),
      ...files.map((f) => ({ label: `$(file) ${f}`, value: f, action: 'file' })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: options.title,
      placeHolder: current,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.action === 'file' && picked.value) {
      return { path: joinPosix(current, picked.value), isDir: false };
    }
    if (picked.action === 'dir' && picked.value) {
      current = joinPosix(current, picked.value);
      continue;
    }
    if (picked.action === 'up') {
      current = current.slice(0, current.lastIndexOf('/')) || '/';
    } else if (picked.action === 'use') {
      return { path: current, isDir: true };
    } else if (picked.action === 'new') {
      const name = await vscode.window.showInputBox({
        title: `New folder in ${current}`,
        value: options.suggestedName ?? '',
        validateInput: (v) => (!v.trim() || /\//.test(v) ? 'Enter a folder name without "/"' : undefined),
      });
      if (name) {
        const dir = joinPosix(current, name.trim());
        try {
          await conn.mkdirp(dir);
          return { path: dir, isDir: true };
        } catch (err) {
          void vscode.window.showErrorMessage(`Could not create ${dir}: ${(err as Error).message}`);
        }
      }
    } else if (picked.action === 'type') {
      const typed = await vscode.window.showInputBox({
        title: options.typePrompt ?? (allowFiles ? 'Path on the server' : 'Folder on the server'),
        value: current + '/',
      });
      if (!typed?.trim()) continue;
      const resolved = conn.resolvePath(typed.trim());
      if (!allowFiles) return { path: resolved, isDir: true };
      const st = await conn.stat(resolved).catch(() => undefined);
      if (!st) {
        void vscode.window.showWarningMessage(`${resolved} does not exist on the server.`);
        continue;
      }
      return { path: resolved, isDir: st.isDir };
    }
  }
}

type BasketItem = vscode.QuickPickItem & {
  action?: 'confirm' | 'add-current' | 'new' | 'type' | 'up' | 'dir' | 'file';
  value?: string;
  entryPath?: string;
  entryIsDir?: boolean;
};

/**
 * Multi-select remote browser with a selection basket.
 * Folders navigate on accept; the item button toggles basket membership.
 * Files toggle on accept or via the button. Confirm with “Use N selected”.
 */
export async function pickRemotePaths(conn: Connection, options: PickRemoteOptions): Promise<RemotePick[] | undefined> {
  const allowFiles = options.allowFiles !== false;
  const basket = new Map<string, RemotePick>();
  let current = options.startAt ? conn.resolvePath(options.startAt) : conn.home;

  const qp = vscode.window.createQuickPick<BasketItem>();
  qp.ignoreFocusOut = true;
  qp.matchOnDescription = true;
  qp.title = options.title;

  const addBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('add'),
    tooltip: 'Add to selection',
  };
  const removeBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('check'),
    tooltip: 'Remove from selection',
  };

  const sortName = (a: string, b: string) =>
    Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b);

  const toggle = (remotePath: string, isDir: boolean): void => {
    if (basket.has(remotePath)) basket.delete(remotePath);
    else basket.set(remotePath, { path: remotePath, isDir });
  };

  const buildItems = async (): Promise<BasketItem[]> => {
    let dirs: string[] = [];
    let files: string[] = [];
    try {
      const entries = await conn.readdir(current);
      dirs = entries
        .filter((e) => e.isDir)
        .map((e) => e.name)
        .sort(sortName);
      if (allowFiles) {
        files = entries
          .filter((e) => e.isFile)
          .map((e) => e.name)
          .sort(sortName);
      }
    } catch {
      void vscode.window.showWarningMessage(`Cannot open ${current} on the server.`);
      if (current === '/' || current === conn.home) return [];
      current = conn.home;
      return buildItems();
    }

    const n = basket.size;
    const items: BasketItem[] = [
      {
        label: n ? `$(check) Use ${n} selected` : '$(circle-slash) Use selected',
        description: n ? undefined : 'select at least one file or folder',
        action: 'confirm',
      },
      {
        label: basket.has(current) ? '$(check) Current folder in selection' : '$(folder-active) Select this folder',
        description: current,
        action: 'add-current',
      },
      { label: '$(new-folder) Create a new folder here…', action: 'new' },
      { label: '$(edit) Type a path…', action: 'type' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...(current !== '/' ? [{ label: '$(arrow-up) ..', description: 'parent folder', action: 'up' as const }] : []),
      ...dirs.map((d) => {
        const entryPath = joinPosix(current, d);
        const selected = basket.has(entryPath);
        return {
          label: `$(folder) ${d}`,
          description: selected ? 'in selection — click to open' : 'click to open',
          value: d,
          action: 'dir' as const,
          entryPath,
          entryIsDir: true,
          buttons: [selected ? removeBtn : addBtn],
        };
      }),
      ...files.map((f) => {
        const entryPath = joinPosix(current, f);
        const selected = basket.has(entryPath);
        return {
          label: selected ? `$(check) ${f}` : `$(file) ${f}`,
          description: selected ? 'in selection' : undefined,
          value: f,
          action: 'file' as const,
          entryPath,
          entryIsDir: false,
          buttons: [selected ? removeBtn : addBtn],
        };
      }),
    ];
    return items;
  };

  const refresh = async (): Promise<void> => {
    qp.busy = true;
    qp.placeholder = `${current}  ·  ${basket.size} selected`;
    qp.items = await buildItems();
    qp.busy = false;
  };

  return new Promise<RemotePick[] | undefined>((resolve) => {
    let settled = false;
    let busy = false;

    const finish = (value: RemotePick[] | undefined): void => {
      if (settled) return;
      settled = true;
      qp.dispose();
      resolve(value);
    };

    const withInput = async (fn: () => Promise<void>): Promise<void> => {
      busy = true;
      qp.hide();
      try {
        await fn();
      } finally {
        if (!settled) {
          qp.show();
          busy = false;
          await refresh();
        }
      }
    };

    qp.onDidTriggerItemButton((e) => {
      if (!e.item.entryPath) return;
      toggle(e.item.entryPath, e.item.entryIsDir === true);
      void refresh();
    });

    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      if (!item?.action) return;
      void (async () => {
        if (item.action === 'confirm') {
          if (basket.size < 1) {
            void vscode.window.showWarningMessage('Select at least one file or folder.');
            return;
          }
          finish([...basket.values()]);
          return;
        }
        if (item.action === 'add-current') {
          toggle(current, true);
          await refresh();
          return;
        }
        if (item.action === 'up') {
          current = current.slice(0, current.lastIndexOf('/')) || '/';
          await refresh();
          return;
        }
        if (item.action === 'dir' && item.value) {
          current = joinPosix(current, item.value);
          await refresh();
          return;
        }
        if (item.action === 'file' && item.entryPath) {
          toggle(item.entryPath, false);
          await refresh();
          return;
        }
        if (item.action === 'new') {
          await withInput(async () => {
            const name = await vscode.window.showInputBox({
              title: `New folder in ${current}`,
              value: options.suggestedName ?? '',
              ignoreFocusOut: true,
              validateInput: (v) => (!v.trim() || /\//.test(v) ? 'Enter a folder name without "/"' : undefined),
            });
            if (!name) return;
            const dir = joinPosix(current, name.trim());
            try {
              await conn.mkdirp(dir);
              current = dir;
            } catch (err) {
              void vscode.window.showErrorMessage(`Could not create ${dir}: ${(err as Error).message}`);
            }
          });
          return;
        }
        if (item.action === 'type') {
          await withInput(async () => {
            const typed = await vscode.window.showInputBox({
              title: options.typePrompt ?? 'Path on the server',
              value: current + '/',
              ignoreFocusOut: true,
            });
            if (!typed?.trim()) return;
            const resolved = conn.resolvePath(typed.trim());
            const st = await conn.stat(resolved).catch(() => undefined);
            if (!st) {
              void vscode.window.showWarningMessage(`${resolved} does not exist on the server.`);
              return;
            }
            if (st.isDir) {
              current = resolved;
              return;
            }
            if (!allowFiles) {
              void vscode.window.showWarningMessage(`${resolved} is a file; pick a folder.`);
              return;
            }
            toggle(resolved, false);
          });
        }
      })();
    });

    qp.onDidHide(() => {
      if (!busy) finish(undefined);
    });

    void refresh().then(() => {
      if (!settled) qp.show();
    });
  });
}

/** Local files and/or folders for one-shot upload (at least one). */
export async function pickLocalUploadSources(): Promise<string[] | undefined> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Upload',
    title: 'Tether: choose what to upload',
  });
  if (!chosen?.length) return undefined;
  return chosen.map((u) => u.fsPath);
}

/**
 * Local destinations for one or more remote picks.
 * Single remote file → save dialog; otherwise a folder, with each basename placed inside.
 */
export async function pickLocalDownloadDests(picks: RemotePick[]): Promise<string[] | undefined> {
  if (picks.length === 1 && !picks[0].isDir) {
    const name = picks[0].path.split('/').filter(Boolean).pop() ?? 'download';
    const saved = await vscode.window.showSaveDialog({
      title: 'Tether: save download as',
      saveLabel: 'Download',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), name)),
    });
    return saved ? [saved.fsPath] : undefined;
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Download Here',
    title: 'Tether: choose where to download',
  });
  if (!chosen?.[0]) return undefined;
  const dir = chosen[0].fsPath;
  return picks.map((p) => {
    const name = p.path.split('/').filter(Boolean).pop() ?? 'download';
    return path.join(dir, name);
  });
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
