import * as vscode from 'vscode';
import { Bindings } from './bindings';
import { joinPosix } from './core/connection';
import { resolveRelaySelection, type RelaySelectionOk } from './core/relaySelection';
import { downloadPath, relayPath, uploadPath } from './core/transfer';
import type { Session, Shared } from './session';
import {
  connectWithProgress,
  pickLocalDownloadDests,
  pickLocalUploadSources,
  pickRemotePath,
  pickRemotePaths,
  pickTarget,
  type RemotePick,
} from './wizard';

/** Normalize Explorer context-menu args (clicked URI + multi-selection). */
export function explorerSelection(resource?: vscode.Uri, resources?: vscode.Uri[]): vscode.Uri[] {
  if (Array.isArray(resources) && resources.length) return resources.filter((u) => !!u);
  if (resource) return [resource];
  return [];
}

/**
 * Turn Explorer selection into Relay source paths on one host.
 * Returns undefined when there is no selection (caller should use the picker).
 */
export function relaySourcesFromExplorer(
  uris: vscode.Uri[],
  sessions: Iterable<Session>,
): RelaySelectionOk | { ok: false; reason: string } | undefined {
  if (!uris.length) return undefined;
  const roots = [...sessions]
    .filter((s) => s.remoteRoot)
    .map((s) => ({
      target: s.binding.target,
      localRoot: s.localRoot,
      remoteRoot: s.remoteRoot,
    }));
  return resolveRelaySelection(uris, roots);
}

async function liveConn(session: Session): Promise<Session['conn']> {
  if (session.conn && !session.conn.closed) return session.conn;
  await session.start(true);
  if (!session.conn || session.conn.closed) {
    void vscode.window.showWarningMessage('Connect to a server first, then try again.');
    return undefined;
  }
  return session.conn;
}

function basenameOf(remoteOrLocal: string): string {
  const parts = remoteOrLocal.replace(/\/+$/, '').split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'download';
}

/** After a one-shot transfer under the paired remote root, let continuous sync catch up. */
function nudgeIfUnderRoot(session: Session | undefined, remoteAbs: string): void {
  if (!session) return;
  const root = (session.remoteRoot || '').replace(/\/+$/, '');
  if (!root) return;
  if (remoteAbs === root || remoteAbs.startsWith(root + '/')) session.nudge();
}

/** Upload local files/folders: system multi-picker first, then remote destination browser. */
export async function uploadCommand(session: Session): Promise<void> {
  const conn = await liveConn(session);
  if (!conn) return;

  const locals = await pickLocalUploadSources();
  if (!locals?.length) return;

  const label =
    locals.length === 1 ? `“${basenameOf(locals[0])}”` : `${locals.length} items`;
  const destDir = await pickRemotePath(conn, {
    title: `Tether: upload ${label} to…`,
    startAt: session.remoteRoot || conn.home,
    typePrompt: 'Upload destination folder on the server',
  });
  if (!destDir) return;

  const total = locals.length;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Uploading 1/${total}…` },
    async (progress) => {
      for (let i = 0; i < locals.length; i++) {
        const localAbs = locals[i];
        const name = basenameOf(localAbs);
        progress.report({ message: `${i + 1}/${total}: ${name}` });
        const remoteAbs = joinPosix(destDir.path, name);
        await uploadPath(conn, localAbs, remoteAbs);
        nudgeIfUnderRoot(session, remoteAbs);
      }
    },
  );
  void vscode.window.showInformationMessage(
    total === 1
      ? `Uploaded to ${conn.label}:${joinPosix(destDir.path, basenameOf(locals[0]))}`
      : `Uploaded ${total} items to ${conn.label}:${destDir.path}`,
  );
}

/** Download remote files/folders: selection basket first, then local destination. */
export async function downloadCommand(session: Session): Promise<void> {
  const conn = await liveConn(session);
  if (!conn) return;

  const remotes = await pickRemotePaths(conn, {
    title: `Tether: choose what to download from ${conn.label}`,
    allowFiles: true,
    startAt: session.remoteRoot || conn.home,
    typePrompt: 'Path on the server to download',
  });
  if (!remotes?.length) return;

  const locals = await pickLocalDownloadDests(remotes);
  if (!locals?.length) return;

  const total = remotes.length;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Downloading 1/${total}…` },
    async (progress) => {
      for (let i = 0; i < remotes.length; i++) {
        const name = basenameOf(remotes[i].path);
        progress.report({ message: `${i + 1}/${total}: ${name}` });
        await downloadPath(conn, remotes[i].path, locals[i]);
      }
    },
  );
  void vscode.window.showInformationMessage(
    total === 1 ? `Downloaded to ${locals[0]}` : `Downloaded ${total} items`,
  );
}

/**
 * Copy or move files/folders between two remote locations (session-aware source host).
 * Opens its own SSH connections when needed; does not require a live sync session.
 *
 * When `preselected` is set (Explorer selection from Remote View or a paired local
 * folder), those paths are used as the transfer sources and the source picker is skipped.
 */
export async function relayCommand(
  session: Session | undefined,
  shared: Shared,
  bindings: Bindings,
  preselected?: RelaySelectionOk,
): Promise<void> {
  const modePick = await vscode.window.showQuickPick(
    [
      { label: '$(files) Copy', description: 'leave the originals in place', value: 'copy' as const },
      { label: '$(arrow-right) Move', description: 'remove the originals after a successful transfer', value: 'move' as const },
    ],
    { title: 'Tether Relay: copy or move between remote locations?', ignoreFocusOut: true },
  );
  if (!modePick) return;
  const mode = modePick.value;

  let srcTarget: string | undefined = preselected?.target;
  if (!srcTarget) {
    const preferred = session?.binding.target;
    srcTarget = await pickTarget(bindings, {
      title: 'Tether Relay: source server',
      preferred,
    });
  }
  if (!srcTarget) return;

  let srcConn = session?.conn && !session.conn.closed && session.binding.target === srcTarget ? session.conn : undefined;
  let srcOwned = false;
  if (!srcConn) {
    srcConn = await connectWithProgress(srcTarget, shared);
    if (!srcConn) return;
    srcOwned = true;
  }

  try {
    let sources: RemotePick[] | undefined;
    if (preselected?.paths.length) {
      sources = preselected.paths.map((p) => ({ path: p, isDir: false }));
    } else {
      sources = await pickRemotePaths(srcConn, {
        title: `Tether Relay: choose what to ${mode} from ${srcConn.label}`,
        allowFiles: true,
        startAt: session?.binding.target === srcTarget ? session.remoteRoot || srcConn.home : srcConn.home,
        typePrompt: 'Path on the source server',
      });
    }
    if (!sources?.length) return;

    const dstTarget = await pickTarget(bindings, { title: 'Tether Relay: destination server' });
    if (!dstTarget) return;

    let dstConn =
      dstTarget === srcTarget
        ? srcConn
        : session?.conn && !session.conn.closed && session.binding.target === dstTarget
          ? session.conn
          : undefined;
    let dstOwned = false;
    if (!dstConn) {
      dstConn = await connectWithProgress(dstTarget, shared);
      if (!dstConn) return;
      dstOwned = true;
    }

    try {
      const label =
        sources.length === 1 ? `“${basenameOf(sources[0].path)}”` : `${sources.length} items`;
      const destDir = await pickRemotePath(dstConn, {
        title: `Tether Relay: ${mode} ${label} to…`,
        startAt: session?.binding.target === dstTarget ? session.remoteRoot || dstConn.home : dstConn.home,
        typePrompt: 'Destination folder on the server',
      });
      if (!destDir) return;

      const total = sources.length;
      const verb = mode === 'move' ? 'Moving' : 'Copying';
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${verb} 1/${total}…` },
        async (progress) => {
          for (let i = 0; i < sources.length; i++) {
            const from = sources[i].path;
            const name = basenameOf(from);
            const to = joinPosix(destDir.path, name);
            progress.report({ message: `${i + 1}/${total}: ${name}` });
            await relayPath(srcConn!, dstConn!, from, to, mode);
            nudgeIfUnderRoot(session, to);
            if (mode === 'move') nudgeIfUnderRoot(session, from);
          }
        },
      );

      void vscode.window.showInformationMessage(
        total === 1
          ? `${mode === 'move' ? 'Moved' : 'Copied'} to ${dstConn.label}:${joinPosix(destDir.path, basenameOf(sources[0].path))}`
          : `${mode === 'move' ? 'Moved' : 'Copied'} ${total} items to ${dstConn.label}:${destDir.path}`,
      );
    } finally {
      if (dstOwned && dstConn && dstConn !== srcConn) dstConn.close();
    }
  } finally {
    if (srcOwned && srcConn) srcConn.close();
  }
}
