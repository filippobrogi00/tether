import * as path from 'path';
import { joinPosix } from './connection';

/** Minimal Explorer resource shape (works with vscode.Uri or plain objects). */
export type ExplorerResource = {
  scheme: string;
  authority: string;
  path: string;
  fsPath: string;
};

/** Session roots needed to map a local or Remote View URI onto a remote path. */
export type RelaySessionRoots = {
  target: string;
  localRoot: string;
  remoteRoot: string;
};

export type RelaySelectionOk = { ok: true; target: string; paths: string[] };
export type RelaySelectionErr = { ok: false; reason: string };
export type RelaySelectionResult = RelaySelectionOk | RelaySelectionErr;

/**
 * Map Explorer selection (Remote View `tether:` and/or synced `file:` URIs) to
 * absolute remote paths on a single source host. Empty input is not an error —
 * the caller should fall back to the normal picker.
 */
export function resolveRelaySelection(
  resources: ExplorerResource[],
  sessions: RelaySessionRoots[],
): RelaySelectionResult {
  if (!resources.length) {
    return { ok: false, reason: 'No files or folders selected.' };
  }

  let target: string | undefined;
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const resource of resources) {
    const mapped = mapOne(resource, sessions);
    if (!mapped.ok) return mapped;
    if (target && target !== mapped.target) {
      return {
        ok: false,
        reason: 'Relay needs every selected item to be on the same source server.',
      };
    }
    target = mapped.target;
    if (!seen.has(mapped.path)) {
      seen.add(mapped.path);
      paths.push(mapped.path);
    }
  }

  if (!target || !paths.length) {
    return { ok: false, reason: 'No files or folders selected.' };
  }
  return { ok: true, target, paths };
}

function mapOne(
  resource: ExplorerResource,
  sessions: RelaySessionRoots[],
): { ok: true; target: string; path: string } | RelaySelectionErr {
  if (resource.scheme === 'tether') {
    const host = decodeURIComponent(resource.authority || '');
    if (!host) {
      return { ok: false, reason: 'Selected Remote View item has no server.' };
    }
    const session = sessions.find((s) => s.target === host);
    if (!session?.remoteRoot) {
      return {
        ok: false,
        reason: `Connect to ${host} first, then Relay the selected Remote View items.`,
      };
    }
    return { ok: true, target: host, path: tetherUriToRemote(resource.path, session.remoteRoot) };
  }

  if (resource.scheme === 'file') {
    const session = sessions.find((s) => isUnderRoot(resource.fsPath, s.localRoot));
    if (!session) {
      return {
        ok: false,
        reason: 'Selected local items must be inside a folder paired with Tether.',
      };
    }
    if (!session.remoteRoot) {
      return {
        ok: false,
        reason: `Connect to ${session.target} first, then Relay the selected files.`,
      };
    }
    const remote = localToRemote(resource.fsPath, session.localRoot, session.remoteRoot);
    if (!remote) {
      return {
        ok: false,
        reason: 'Selected local items must be inside a folder paired with Tether.',
      };
    }
    return { ok: true, target: session.target, path: remote };
  }

  return {
    ok: false,
    reason: 'Relay can use selections from the local paired folder or Remote View only.',
  };
}

export function tetherUriToRemote(uriPath: string, remoteRoot: string): string {
  const root = remoteRoot.replace(/\/+$/, '') || '/';
  const rel = decodeURIComponent(uriPath || '').replace(/^\/+/, '');
  return rel ? joinPosix(root, rel) : root;
}

export function localToRemote(localAbs: string, localRoot: string, remoteRoot: string): string | undefined {
  const rel = path.relative(localRoot, localAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const posixRel = rel.split(path.sep).join('/');
  const root = remoteRoot.replace(/\/+$/, '') || '/';
  return posixRel ? joinPosix(root, posixRel) : root;
}

function isUnderRoot(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
