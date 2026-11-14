import { Action, FileMap, Manifest, sameStat } from './types';

export interface PlanInput {
  local: FileMap;
  remote: FileMap;
  base: Manifest;
  /** Paths that exist but were deliberately not scanned (too large). Never touched. */
  skipped?: Set<string>;
  /** True when a path is excluded by the ignore rules. */
  isIgnored?: (path: string) => boolean;
  /**
   * Restrict planning to these paths (fast path after a local change).
   * When omitted, every path known to any side is considered.
   */
  only?: Iterable<string>;
}

/**
 * Three-way reconciliation, the same idea Unison and Mutagen use.
 *
 * Each side is compared against the manifest ("what it looked like when we last
 * agreed"), never against the other side. That makes the result independent of
 * clock differences between the two machines, and it lets us tell "deleted
 * here" apart from "created there".
 *
 * Pure function: no I/O, fully unit-testable.
 */
export function plan(input: PlanInput): Action[] {
  const { local, remote, base, skipped, isIgnored } = input;
  const paths = new Set<string>(input.only ?? [...local.keys(), ...remote.keys(), ...base.keys()]);
  const actions: Action[] = [];

  for (const path of paths) {
    if (skipped?.has(path)) continue;

    const l = local.get(path);
    const r = remote.get(path);
    const b = base.get(path);

    if (!b) {
      if (l && r) {
        // Never synced but present on both sides (first connect, or an interrupted run).
        actions.push(l.size === r.size ? { kind: 'verify', path } : { kind: 'conflict', path, reason: 'both-new' });
      } else if (l) {
        actions.push({ kind: 'upload', path });
      } else if (r) {
        actions.push({ kind: 'download', path });
      }
      continue;
    }

    // A tracked file that just became ignored is not a deletion: stop tracking it.
    if ((!l || !r) && isIgnored?.(path)) {
      actions.push({ kind: 'forget', path });
      continue;
    }

    const localChanged = !sameStat(l, b.l);
    const remoteChanged = !sameStat(r, b.r);

    if (!localChanged && !remoteChanged) continue;

    if (localChanged && !remoteChanged) {
      actions.push(l ? { kind: 'upload', path } : { kind: 'deleteRemote', path });
    } else if (!localChanged && remoteChanged) {
      actions.push(r ? { kind: 'download', path } : { kind: 'deleteLocal', path });
    } else if (!l && !r) {
      actions.push({ kind: 'forget', path });
    } else if (!l) {
      actions.push({ kind: 'conflict', path, reason: 'local-deleted-remote-changed' });
    } else if (!r) {
      actions.push({ kind: 'conflict', path, reason: 'remote-deleted-local-changed' });
    } else {
      actions.push({ kind: 'conflict', path, reason: 'both-changed' });
    }
  }

  return actions;
}
