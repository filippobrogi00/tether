/**
 * Shared types for the sync core.
 *
 * Nothing under src/core imports `vscode`, so the whole engine can be run and
 * tested from plain Node (see test/).
 */

/** Size + modification time of a file. Local mtimes are in ms, remote in whole seconds. */
export interface FileStat {
  size: number;
  mtime: number;
  /** POSIX permission bits (remote always, local on POSIX only). */
  mode?: number;
}

/** Relative POSIX path ("src/main.c") -> stat. */
export type FileMap = Map<string, FileStat>;

/** What both sides looked like the last time a file was known to be in sync. */
export interface BaseEntry {
  l: FileStat;
  r: FileStat;
}

export type Manifest = Map<string, BaseEntry>;

export type ConflictReason =
  | 'both-changed' // edited on both sides since the last sync
  | 'both-new' // exists on both sides, never synced, contents differ
  | 'local-deleted-remote-changed'
  | 'remote-deleted-local-changed';

export type Action =
  | { kind: 'upload'; path: string }
  | { kind: 'download'; path: string }
  | { kind: 'deleteRemote'; path: string }
  | { kind: 'deleteLocal'; path: string }
  /** Present on both sides with no history and equal size: compare hashes. */
  | { kind: 'verify'; path: string }
  /** Gone from both sides (or no longer tracked): drop it from the manifest. */
  | { kind: 'forget'; path: string }
  | { kind: 'conflict'; path: string; reason: ConflictReason };

export interface Conflict {
  path: string;
  reason: ConflictReason;
  local?: FileStat;
  remote?: FileStat;
}

export type ConflictChoice = 'local' | 'remote' | 'both';
export type ConflictPolicy = 'ask' | 'preferLocal' | 'preferRemote' | 'keepBoth';

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: { path: string; message: string }[];
  /** Files left alone because they exceed the size limit. */
  skippedLarge: string[];
  /** True when the user declined a large batch of deletions. */
  deletesDeclined?: boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Everything the core needs to ask a human. The extension implements it with VS Code UI. */
export interface Prompter {
  password(target: string, attempt: number): Promise<string | undefined>;
  passphrase(keyPath: string): Promise<string | undefined>;
  /** Free-form server prompts (2FA codes, PAM questions). */
  keyboardInteractive(
    target: string,
    instructions: string,
    prompts: { prompt: string; echo: boolean }[],
  ): Promise<string[] | undefined>;
  /** First contact with a host: show the fingerprint and ask whether to trust it. */
  confirmHostKey(target: string, keyType: string, fingerprint: string): Promise<boolean>;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

export function sameStat(a: FileStat | undefined, b: FileStat | undefined): boolean {
  if (!a || !b) return a === b;
  return a.size === b.size && a.mtime === b.mtime;
}
