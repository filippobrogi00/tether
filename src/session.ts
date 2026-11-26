import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { allRemotes, Binding, bindingFromRemotes, Bindings, RemoteRef } from './bindings';
import { Connection, UserCancelled } from './core/connection';
import { DEFAULT_IGNORES, IgnoreRules } from './core/ignore';
import { KnownHosts } from './core/knownHosts';
import { SyncEngine } from './core/syncEngine';
import { remoteRemove } from './core/transfer';
import { ConflictPolicy, Logger, SyncResult } from './core/types';
import { VscodePrompter } from './prompter';
import { TETHER_SCHEME } from './remoteFs';
import { confirmRemoteTerminals, openRemoteTerminal, RemoteTerminalHandle } from './terminal';

export type SessionState = 'connecting' | 'syncing' | 'idle' | 'conflicts' | 'error' | 'offline' | 'paused' | 'stopped';

/** Per-file sync status for the status bar / tooltip. */
export type FileSyncStatus = 'pending' | 'syncing' | 'error';

/** How full sync visits remotes. First connect is ordered; reconnect is parallel. */
export type SyncStrategy = 'ordered' | 'parallel';

export interface Shared {
  context: vscode.ExtensionContext;
  log: Logger;
  prompter: VscodePrompter;
  knownHosts: KnownHosts;
  bindings: Bindings;
}

/** One remote side of a multi-remote session (own connection, engine, manifest). */
export type RemotePeer = {
  readonly ref: RemoteRef;
  conn?: Connection;
  engine?: SyncEngine;
  remoteRoot: string;
  /**
   * Server added while this folder was already syncing. Left out of uploads and
   * parallel sync until its first reconcile (the same ordered merge as a first connect).
   */
  initialSyncPending?: boolean;
  /** Remote View Explorer root is showing for this server. */
  remoteViewActive: boolean;
};

const DEBOUNCE_MS = 350;
const RETRY_DELAYS_S = [3, 5, 10, 20, 40, 60];

function emptyResult(): SyncResult {
  return { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, errors: [], skippedLarge: [] };
}

function mergeResults(parts: SyncResult[]): SyncResult {
  const out = emptyResult();
  for (const r of parts) {
    out.uploaded += r.uploaded;
    out.downloaded += r.downloaded;
    out.deletedLocal += r.deletedLocal;
    out.deletedRemote += r.deletedRemote;
    out.conflicts += r.conflicts;
    out.errors.push(...r.errors);
    out.skippedLarge.push(...r.skippedLarge);
    if (r.deletesDeclined) out.deletesDeclined = true;
  }
  return out;
}

/**
 * One local folder kept in sync with one or more remote folders.
 * Owns connections, engines, the file watcher, timers and reconnect logic.
 * Local is the hub: each remote syncs with local independently.
 */
export class Session implements vscode.Disposable {
  state: SessionState = 'stopped';
  /** Short human-readable note for the status bar tooltip (progress or last problem). */
  detail = '';
  lastSync?: Date;
  /** All remotes, primary first. */
  readonly peers: RemotePeer[] = [];
  /** Paths currently dirty, in flight, or failed on the last sync attempt. */
  readonly fileStatus = new Map<string, FileSyncStatus>();
  /** Keep-alive remote terminals opened for this pairing. */
  readonly remoteTerminals: RemoteTerminalHandle[] = [];
  /** Peer index emphasized in status (during ordered sync / conflict review). */
  activePeerIndex = 0;
  /** Last remote chosen for Remote Terminal (multi-remote). */
  lastTerminalTarget?: string;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly forwards: net.Server[] = [];
  private readonly pending = new Set<string>();
  private busy = 0;
  private flushTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;
  private retries = 0;
  private watching = false;
  private disposed = false;
  private warnedLarge = false;
  private knownConflicts = 0;
  private lastErrors = '';
  private lastSyncHadErrors = false;
  private terminalCounts = new Map<string, number>();
  private syncStrategy: SyncStrategy = 'parallel';
  /** Next peer index to reconcile in ordered mode. */
  private orderedIndex = 0;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    readonly binding: Binding,
    private readonly shared: Shared,
  ) {
    for (const ref of allRemotes(binding)) {
      this.peers.push({ ref, remoteRoot: '', remoteViewActive: false });
    }
  }

  get localRoot(): string {
    return this.folder.uri.fsPath;
  }

  /** Primary connection (Remote View, port forward, single-remote callers). */
  get conn(): Connection | undefined {
    return this.peers[0]?.conn;
  }

  /** Primary engine (single-remote callers / ignore checks). */
  get engine(): SyncEngine | undefined {
    return this.peers[0]?.engine;
  }

  get remoteRoot(): string {
    return this.peers[0]?.remoteRoot ?? '';
  }

  get activePeer(): RemotePeer | undefined {
    return this.peers[this.activePeerIndex] ?? this.peers[0];
  }

  conflictCount(): number {
    let n = 0;
    for (const p of this.peers) n += p.engine?.conflicts.size ?? 0;
    return n;
  }

  peersWithConflicts(): RemotePeer[] {
    return this.peers.filter((p) => (p.engine?.conflicts.size ?? 0) > 0);
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('tether', this.folder.uri).get<T>(key, fallback);
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Connect (or adopt already-open connections from the wizard) and start syncing.
   * `strategy`: ordered = first connect (remote1, resolve, remote2, …); parallel = reconnect.
   * `existing` may be one connection for the primary or one per remote in order.
   */
  async start(
    interactive: boolean,
    existing?: Connection | Connection[],
    strategy: SyncStrategy = 'parallel',
  ): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.retryTimer);
    this.syncStrategy = strategy;
    this.orderedIndex = 0;
    this.activePeerIndex = 0;

    const adopted = Array.isArray(existing) ? existing : existing ? [existing] : [];
    const labels = this.peers.map((p) => p.ref.target).join(', ');
    this.setState('connecting', `Connecting to ${labels}…`);

    try {
      for (let i = 0; i < this.peers.length; i++) {
        const peer = this.peers[i];
        this.activePeerIndex = i;
        this.setState('connecting', `Connecting to ${peer.ref.target}…`);

        let conn: Connection | undefined = adopted[i];
        if (conn?.closed) conn = undefined;
        if (!conn) {
          conn = await Connection.open(peer.ref.target, {
            log: this.shared.log,
            knownHosts: this.shared.knownHosts,
            prompter: interactive ? this.shared.prompter : this.shared.prompter.quiet(),
          });
        }
        if (this.disposed) return conn.close();

        peer.conn?.close();
        peer.conn = conn;
        const live = conn;
        live.once('close', () => this.onConnectionLost(peer, live));
        peer.remoteRoot = live.resolvePath(peer.ref.remoteDir);
        if (peer.engine) peer.engine.setConnection(live);
        else peer.engine = this.createEngine(peer, live);
        await peer.engine.init();
        this.shared.log.info(`Connected: ${this.localRoot}  <->  ${peer.ref.target}:${peer.remoteRoot}`);
      }

      void this.shared.prompter.offerToSave();
      this.retries = 0;
      this.startWatching();
      await this.preferUnixLineEndings();
      this.pending.clear();
      this.binding.resumeOnOpen = true;
      await this.shared.bindings.set(this.localRoot, this.binding);
      await this.fullSync();
      this.startPolling();
    } catch (err) {
      this.handleConnectFailure(err as Error, interactive);
    }
  }

  /**
   * Pair another server with this folder and reconcile it the way a first connect does:
   * this server is merged on its own, and conflicts pause the pass until they are resolved.
   * `existing` is a connection the wizard already opened (closed on failure).
   */
  async attachRemote(ref: RemoteRef, existing?: Connection): Promise<void> {
    if (this.disposed) {
      existing?.close();
      return;
    }
    if (this.state === 'stopped' || this.state === 'paused' || this.state === 'offline') {
      existing?.close();
      throw new Error('Reconnect this folder before adding a server.');
    }
    if (this.peers.some((p) => p.ref.target === ref.target)) {
      existing?.close();
      throw new Error(`${ref.target} is already paired with this folder.`);
    }

    const peer: RemotePeer = { ref, remoteRoot: '', remoteViewActive: false, initialSyncPending: true };
    let conn = existing && !existing.closed ? existing : undefined;
    try {
      this.setState('connecting', `Connecting to ${ref.target}…`);
      if (!conn) {
        conn = await Connection.open(ref.target, {
          log: this.shared.log,
          knownHosts: this.shared.knownHosts,
          prompter: this.shared.prompter,
        });
      }
      if (this.disposed) {
        conn.close();
        return;
      }
      peer.conn = conn;
      peer.remoteRoot = conn.resolvePath(ref.remoteDir);
      // Not inserted yet, so this is not the legacy primary; the manifest id is per-remote.
      peer.engine = this.createEngine(peer, conn);
      await peer.engine.init();
    } catch (err) {
      peer.conn?.close();
      if (!this.disposed && this.livePeers().length) this.settle();
      throw err;
    }

    const wasSingle = this.peers.length === 1;
    const previousExtras = this.binding.extraRemotes;
    if (wasSingle) this.binding.primaryLegacyManifest = true;
    this.binding.extraRemotes = [...(previousExtras ?? []), ref];
    this.peers.push(peer);
    try {
      await this.shared.bindings.set(this.localRoot, this.binding);
    } catch (err) {
      this.peers.pop();
      if (wasSingle) delete this.binding.primaryLegacyManifest;
      this.binding.extraRemotes = previousExtras;
      peer.conn?.close();
      peer.conn = undefined;
      if (!this.disposed && this.livePeers().length) this.settle();
      throw err;
    }

    const live = peer.conn;
    if (!live) throw new Error(`Connection to ${ref.target} closed before it was added.`);
    live.once('close', () => this.onConnectionLost(peer, live));
    this.shared.log.info(`Connected: ${this.localRoot}  <->  ${ref.target}:${peer.remoteRoot}`);
    void this.shared.prompter.offerToSave();

    const idx = this.peers.length - 1;
    // A first connect still walking servers in order will reach this one. Starting
    // another pass here would skip whatever that walk has not reconciled yet.
    if (this.syncStrategy === 'ordered') {
      if (this.busy === 0) {
        this.shared.log.info(`${ref.target} will sync after conflicts with the current server are resolved.`);
        this.settle();
      }
      return;
    }
    this.syncStrategy = 'ordered';
    this.orderedIndex = idx;
    this.activePeerIndex = idx;
    await this.orderedSyncFrom(idx);
  }

  /**
   * Point one paired server at a different remote folder, optionally delete the
   * old tree, rebuild that peer's sync engine, and reconcile like a first connect.
   */
  async changeRemoteDir(peerIndex: number, newRemoteDir: string, opts: { cleanupOld: boolean }): Promise<void> {
    if (this.disposed) return;
    if (this.state === 'stopped' || this.state === 'paused' || this.state === 'offline' || this.state === 'connecting') {
      throw new Error('Reconnect this folder before changing the remote folder.');
    }
    if (this.state === 'syncing' || this.busy > 0) {
      throw new Error('Wait until the current sync finishes, then change the folder.');
    }

    const peer = this.peers[peerIndex];
    if (!peer?.conn || peer.conn.closed) throw new Error('That server is not connected.');
    const conn = peer.conn;
    const oldRoot = peer.remoteRoot;
    const newRoot = conn.resolvePath(newRemoteDir);
    const norm = (p: string) => {
      const t = p.replace(/\/+$/, '');
      return t === '' ? '/' : t;
    };
    if (norm(oldRoot) === norm(newRoot)) {
      throw new Error('That folder is already the mount point for this server.');
    }

    this.setState('connecting', `Changing folder on ${peer.ref.target}…`);
    clearInterval(this.pollTimer);

    try {
      if (opts.cleanupOld) {
        const nests =
          norm(oldRoot) === norm(newRoot) ||
          norm(oldRoot).startsWith(`${norm(newRoot)}/`) ||
          norm(newRoot).startsWith(`${norm(oldRoot)}/`);
        if (nests) {
          this.shared.log.warn(
            `Skipping cleanup of ${peer.ref.target}:${oldRoot} because it nests with ${newRoot}`,
          );
        } else {
          await remoteRemove(conn, oldRoot);
          this.shared.log.info(`Removed old remote folder ${peer.ref.target}:${oldRoot}`);
        }
      }

      peer.ref.remoteDir = newRemoteDir;
      const remotes = allRemotes(this.binding).map((r, i) =>
        i === peerIndex ? { target: r.target, remoteDir: newRemoteDir } : { ...r },
      );
      const next = bindingFromRemotes(remotes, this.binding);
      this.binding.target = next.target;
      this.binding.remoteDir = next.remoteDir;
      if (next.extraRemotes) this.binding.extraRemotes = next.extraRemotes;
      else delete this.binding.extraRemotes;

      peer.remoteRoot = newRoot;
      peer.engine = this.createEngine(peer, conn);
      await peer.engine.init();
      peer.initialSyncPending = true;
      this.pending.clear();
      this.knownConflicts = 0;

      await this.shared.bindings.set(this.localRoot, this.binding);
      this.shared.log.info(`Remounted: ${this.localRoot}  <->  ${peer.ref.target}:${peer.remoteRoot}`);

      this.syncStrategy = 'ordered';
      this.orderedIndex = peerIndex;
      this.activePeerIndex = peerIndex;
      await this.orderedSyncFrom(peerIndex);
      if (!this.disposed) this.startPolling();
    } catch (err) {
      if (!this.disposed && this.livePeers().length) {
        this.settle();
        this.startPolling();
      } else if (!this.disposed) {
        this.setState('error', (err as Error).message);
      }
      throw err;
    }
  }

  /**
   * Windows creates new files with CRLF line endings, which break shell scripts
   * and many tools on Linux servers. For paired folders, default new files to LF
   * (only if the user has not chosen something themselves).
   */
  private async preferUnixLineEndings(): Promise<void> {
    if (process.platform !== 'win32') return;
    try {
      const files = vscode.workspace.getConfiguration('files', this.folder.uri);
      const eol = files.inspect<string>('eol');
      if (eol?.workspaceFolderValue === undefined && eol?.workspaceValue === undefined && eol?.globalValue === undefined) {
        await files.update('eol', '\n', vscode.ConfigurationTarget.WorkspaceFolder);
        this.shared.log.info('New files in this folder will use Unix (LF) line endings, as servers expect.');
      }
    } catch {
      /* not essential */
    }
  }

  private handleConnectFailure(err: Error, interactive: boolean): void {
    if (this.disposed) return;
    if (err instanceof UserCancelled) {
      this.setState('offline', interactive ? 'Sign-in cancelled. Click to reconnect.' : 'Sign-in needed. Click to reconnect.');
      return;
    }
    this.shared.log.error(err.message);
    this.setState('offline', err.message);
    if (interactive) {
      void vscode.window.showErrorMessage(`Tether: ${err.message}`, 'Retry', 'Show Log').then((choice) => {
        if (choice === 'Retry') void this.start(true, undefined, this.syncStrategy);
        if (choice === 'Show Log') void vscode.commands.executeCommand('tether.showLog');
      });
    } else {
      this.scheduleRetry();
    }
  }

  private onConnectionLost(peer: RemotePeer, conn: Connection): void {
    if (this.disposed || peer.conn !== conn || this.state === 'stopped') return;
    this.shared.log.warn(`Connection to ${peer.ref.target} lost. Reconnecting…`);
    clearInterval(this.pollTimer);
    this.setState('offline', `Connection to ${peer.ref.target} lost. Reconnecting…`);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_S[Math.min(this.retries++, RETRY_DELAYS_S.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.start(false, undefined, 'parallel'), delay * 1000);
  }

  async stop(): Promise<void> {
    await this.promptAndCloseTerminals();
    this.clearTimers();
    this.binding.resumeOnOpen = false;
    void this.shared.bindings.set(this.localRoot, this.binding);
    this.setState('stopped', 'Disconnected');
    for (const peer of this.peers) {
      peer.conn?.close();
      peer.conn = undefined;
    }
  }

  async promptAndCloseTerminals(): Promise<void> {
    const handles = [...this.remoteTerminals];
    this.remoteTerminals.length = 0;
    if (handles.length) await confirmRemoteTerminals(handles);
  }

  pause(): void {
    if (this.state === 'stopped' || this.state === 'offline') return;
    clearInterval(this.pollTimer);
    this.pending.clear();
    for (const [p, st] of this.fileStatus) {
      if (st === 'pending' || st === 'syncing') this.fileStatus.delete(p);
    }
    this.setState('paused', 'Paused. Nothing is copied in either direction.');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    this.state = 'idle';
    await this.fullSync();
    this.startPolling();
  }

  pendingCount(): number {
    let n = 0;
    for (const st of this.fileStatus.values()) if (st === 'pending' || st === 'syncing') n++;
    return n;
  }

  errorCount(): number {
    let n = 0;
    for (const st of this.fileStatus.values()) if (st === 'error') n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    for (const f of this.forwards) f.close();
    for (const d of this.disposables) d.dispose();
    for (const h of this.remoteTerminals) h.detach();
    this.remoteTerminals.length = 0;
    for (const peer of this.peers) peer.conn?.close();
    this.changed.dispose();
  }

  private clearTimers(): void {
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.nudgeTimer);
    clearInterval(this.pollTimer);
  }

  // ---- engine wiring -------------------------------------------------------

  private createEngine(peer: RemotePeer, conn: Connection): SyncEngine {
    const session = this;
    const storage = this.shared.context.globalStorageUri.fsPath;
    // Single-remote, and the primary of a folder that later gained a server, keep the
    // legacy manifest id (local path only) so an existing pairing does not cold-start.
    // A folder that was paired with several servers at once uses a per-remote id for each.
    // A peer not in the list yet is a server being added; it is never that primary.
    const index = this.peers.indexOf(peer);
    const legacyPrimary = index === 0 && (this.peers.length === 1 || this.binding.primaryLegacyManifest === true);
    const idKey = legacyPrimary ? this.localRoot : `${this.localRoot}\0${peer.ref.target}\0${peer.ref.remoteDir}`;
    const id = crypto.createHash('sha1').update(idKey).digest('hex').slice(0, 16);
    return new SyncEngine(conn, {
      localRoot: this.localRoot,
      remoteRoot: peer.remoteRoot,
      manifestFile: path.join(storage, 'manifests', `${id}.json`),
      log: this.shared.log,
      sshTarget: peer.ref.target,
      loadIgnore: () =>
        IgnoreRules.load(
          this.localRoot,
          this.config<string[]>('ignore', DEFAULT_IGNORES),
          this.config('respectGitignore', false),
          { exclude: this.binding.rootExclude, include: this.binding.rootInclude },
        ),
      get maxFileSize() {
        return session.config('maxFileSizeMB', 100) * 1024 * 1024;
      },
      get concurrency() {
        return Math.max(1, session.config('concurrency', 6));
      },
      get conflictPolicy() {
        return session.config<ConflictPolicy>('conflictPolicy', 'ask');
      },
      get confirmDeletesOver() {
        return session.config('confirmDeletesOver', 25);
      },
      get compressTransfers() {
        return session.config('compressTransfers', true);
      },
      removeLocal: async (abs) => {
        const uri = vscode.Uri.file(abs);
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } catch {
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        }
      },
      onDetail: (detail) => {
        if (this.state === 'paused' || this.state === 'stopped' || this.state === 'offline') return;
        this.detail = `${peer.ref.target}: ${detail}`;
        this.changed.fire();
      },
      confirmDeletes: async (count, sample) => {
        const go = `Delete ${count} Files`;
        const choice = await vscode.window.showWarningMessage(
          `Tether (${peer.ref.target}) is about to delete ${count} files to mirror deletions from the other side.`,
          { modal: true, detail: `For example:\n${sample.join('\n')}\n\nChoose Cancel to pause syncing and review.` },
          go,
        );
        return choice === go;
      },
      onProgress: (done, total) => {
        if (total > 3) {
          this.detail = `${peer.ref.target}: syncing ${done}/${total}`;
          this.changed.fire();
        }
      },
    });
  }

  private livePeers(): RemotePeer[] {
    return this.peers.filter((p) => p.engine && p.conn && !p.conn.closed && !p.initialSyncPending);
  }

  private usable(): boolean {
    return this.livePeers().length > 0 && this.state !== 'paused' && this.state !== 'stopped';
  }

  /** Scan and reconcile. Ordered on first connect (gates on conflicts); parallel on reconnect. */
  async fullSync(): Promise<void> {
    if (!this.usable() || this.state === 'offline') return;
    if (this.syncStrategy === 'ordered') {
      await this.orderedSyncFrom(this.orderedIndex);
    } else {
      await this.parallelSync();
    }
  }

  private async orderedSyncFrom(startIdx: number): Promise<void> {
    for (let i = startIdx; i < this.peers.length; i++) {
      const peer = this.peers[i];
      if (!peer.engine || !peer.conn || peer.conn.closed) continue;
      this.orderedIndex = i;
      this.activePeerIndex = i;
      await this.run(() => peer.engine!.reconcile(), undefined, `Syncing with ${peer.ref.target}…`);
      peer.initialSyncPending = false;
      if ((peer.engine?.conflicts.size ?? 0) > 0) {
        this.settle();
        return;
      }
    }
    this.syncStrategy = 'parallel';
    this.orderedIndex = 0;
    this.settle();
  }

  private async parallelSync(): Promise<void> {
    const peers = this.livePeers();
    if (peers.length === 0) return;
    if (peers.length === 1) {
      this.activePeerIndex = this.peers.indexOf(peers[0]);
      await this.run(() => peers[0].engine!.reconcile(), undefined, `Syncing with ${peers[0].ref.target}…`);
      return;
    }
    await this.run(
      async () => {
        const results = await Promise.all(
          peers.map(async (peer) => {
            try {
              return await peer.engine!.reconcile();
            } catch (err) {
              const r = emptyResult();
              r.errors.push({ path: peer.ref.target, message: (err as Error).message });
              return r;
            }
          }),
        );
        return mergeResults(results);
      },
      undefined,
      `Syncing ${peers.length} servers…`,
    );
  }

  private async run(job: () => Promise<SyncResult>, paths?: string[], leadDetail?: string): Promise<void> {
    const lead = this.busy === 0;
    this.busy++;
    const ignoreEngine = this.engine;
    const active = paths?.filter((p) => !ignoreEngine?.ignores(p));
    if (paths) {
      for (const p of paths) if (ignoreEngine?.ignores(p)) this.fileStatus.delete(p);
    }
    if (active?.length) for (const p of active) this.fileStatus.set(p, lead ? 'syncing' : 'pending');
    if (lead) {
      this.setState(
        'syncing',
        leadDetail ?? (active?.length ? `Syncing ${active.length} file(s)…` : 'Syncing…'),
      );
    }
    try {
      this.report(await job(), active);
      this.lastSync = new Date();
    } catch (err) {
      this.shared.log.error(`Sync failed: ${(err as Error).message}`);
      this.lastSyncHadErrors = true;
      this.detail = `Last sync failed: ${(err as Error).message}`;
      if (active) for (const p of active) this.fileStatus.set(p, 'error');
    } finally {
      this.busy--;
      if (this.busy === 0 && (this.state === 'syncing' || this.state === 'error')) this.settle();
    }
  }

  private settle(): void {
    const n = this.conflictCount();
    if (n > this.knownConflicts) {
      const peer = this.peersWithConflicts()[0];
      const where = peer ? ` with ${peer.ref.target}` : '';
      void vscode.window
        .showWarningMessage(
          n === 1
            ? `Tether: 1 file was changed both here and on the server${where}.`
            : `Tether: ${n} files were changed both here and on the server${where}.`,
          'Review',
        )
        .then((c) => c && vscode.commands.executeCommand('tether.resolveConflicts'));
    }
    this.knownConflicts = n;

    if (this.pending.size > 0 || this.pendingCount() > 0) {
      this.setState('syncing', `${this.pending.size || this.pendingCount()} change(s) queued`);
      return;
    }
    if (n > 0) {
      const peer = this.peersWithConflicts()[0];
      if (peer) this.activePeerIndex = this.peers.indexOf(peer);
      const label = peer ? peer.ref.target : 'server';
      this.setState('conflicts', `${n} file(s) need your decision (${label})`);
    } else if (this.lastSyncHadErrors) this.setState('error', this.detail || 'Sync failed for one or more files');
    else this.setState('idle', '');
  }

  /**
   * After conflict UI clears a peer, continue the ordered first-connect pass if needed.
   */
  refresh(): void {
    if (this.busy > 0) return;
    if (this.syncStrategy === 'ordered') {
      const peer = this.peers[this.orderedIndex];
      if (peer && (peer.engine?.conflicts.size ?? 0) === 0) {
        void this.orderedSyncFrom(this.orderedIndex + 1);
        return;
      }
    }
    if (this.state === 'conflicts' || this.state === 'idle' || this.state === 'error') this.settle();
  }

  private report(res: SyncResult, syncedPaths?: string[]): void {
    const parts = [
      res.uploaded && `${res.uploaded} uploaded`,
      res.downloaded && `${res.downloaded} downloaded`,
      res.deletedRemote && `${res.deletedRemote} deleted on server`,
      res.deletedLocal && `${res.deletedLocal} deleted locally`,
      res.conflicts && `${res.conflicts} conflict(s)`,
    ].filter(Boolean);
    if (parts.length) this.shared.log.info(parts.join(', '));
    this.detail = '';

    const failed = new Set(res.errors.map((e) => e.path));
    if (syncedPaths) {
      for (const p of syncedPaths) {
        if (failed.has(p)) this.fileStatus.set(p, 'error');
        else this.fileStatus.delete(p);
      }
    }
    for (const e of res.errors) this.fileStatus.set(e.path, 'error');

    for (const e of res.errors.slice(0, 20)) this.shared.log.error(`${e.path}: ${e.message}`);
    const signature = res.errors
      .map((e) => e.path)
      .sort()
      .join('\n');
    const isNew = signature !== this.lastErrors;
    this.lastErrors = signature;
    this.lastSyncHadErrors = res.errors.length > 0;
    if (res.errors.length) this.detail = `Last sync failed for ${res.errors.length} file(s)`;
    else {
      for (const [p, st] of [...this.fileStatus]) {
        if (st === 'error' && !this.pending.has(p)) this.fileStatus.delete(p);
      }
    }
    if (res.errors.length && isNew && this.livePeers().length) {
      void vscode.window
        .showWarningMessage(`Tether could not sync ${res.errors.length} file(s).`, 'Show Log')
        .then((c) => c && vscode.commands.executeCommand('tether.showLog'));
    }

    if (res.skippedLarge.length && !this.warnedLarge) {
      this.warnedLarge = true;
      const limit = this.config('maxFileSizeMB', 100);
      this.shared.log.warn(`Skipped (larger than ${limit} MB): ${res.skippedLarge.join(', ')}`);
      void vscode.window.showInformationMessage(
        `Tether skipped ${res.skippedLarge.length} file(s) larger than ${limit} MB. Change "tether.maxFileSizeMB" to include them.`,
      );
    }

    if (res.deletesDeclined) {
      this.pause();
      void vscode.window.showInformationMessage('Tether is paused so you can review. Nothing was deleted.', 'Resume').then((c) => {
        if (c === 'Resume') void this.resume();
      });
    }
  }

  // ---- change detection ----------------------------------------------------

  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    const note = (uri: vscode.Uri) => this.noteLocalChange(uri);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(note),
      watcher.onDidChange(note),
      watcher.onDidDelete(note),
      vscode.workspace.onDidSaveTextDocument((doc) => note(doc.uri)),
      vscode.window.onDidChangeWindowState((w) => {
        if (w.focused && this.lastSync && Date.now() - this.lastSync.getTime() > 10_000) void this.fullSync();
      }),
    );
  }

  private noteLocalChange(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const rel = path.relative(this.localRoot, uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const posix = rel.split(path.sep).join('/');
    if (this.engine?.ignores(posix)) return;
    this.pending.add(posix);
    this.fileStatus.set(posix, 'pending');
    if (this.usable() && this.state !== 'offline' && this.state !== 'connecting' && this.state !== 'paused') {
      if (this.busy === 0) this.setState('syncing', `${this.pending.size} change(s) queued`);
      else this.changed.fire();
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (!this.usable() || this.state === 'offline' || this.state === 'connecting') {
      return;
    }
    const paths: string[] = [];
    for (const p of this.pending) {
      if (this.engine?.ignores(p)) this.fileStatus.delete(p);
      else paths.push(p);
    }
    this.pending.clear();
    if (!paths.length) {
      if (this.busy === 0 && (this.state === 'syncing' || this.state === 'error')) this.settle();
      return;
    }
    const peers = this.livePeers();
    await this.run(
      async () => {
        const results = await Promise.all(
          peers.map(async (peer) => {
            try {
              return await peer.engine!.pushPaths(paths);
            } catch (err) {
              const r = emptyResult();
              r.errors.push({ path: peer.ref.target, message: (err as Error).message });
              return r;
            }
          }),
        );
        return mergeResults(results);
      },
      paths,
      peers.length > 1 ? `Uploading to ${peers.length} servers…` : undefined,
    );
  }

  private startPolling(): void {
    clearInterval(this.pollTimer);
    const seconds = this.config('pollIntervalSeconds', 60);
    if (seconds > 0) {
      this.pollTimer = setInterval(() => {
        if (this.busy === 0) void this.fullSync();
      }, Math.max(10, seconds) * 1000);
    }
  }

  nudge(): void {
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => void this.fullSync(), 3000);
  }

  // ---- features built on the connection --------------------------------------

  async openTerminal(): Promise<void> {
    const peer = await this.pickTerminalPeer();
    if (!peer?.conn || peer.conn.closed) {
      void vscode.window.showWarningMessage('Connect to a server first, then open a terminal.');
      return;
    }
    this.lastTerminalTarget = peer.ref.target;
    const n = (this.terminalCounts.get(peer.ref.target) ?? 0) + 1;
    this.terminalCounts.set(peer.ref.target, n);
    const name = n === 1 ? peer.ref.target : `${peer.ref.target} #${n}`;
    const handle = openRemoteTerminal(
      () => peer.conn,
      () =>
        Connection.open(peer.ref.target, {
          log: this.shared.log,
          knownHosts: this.shared.knownHosts,
          prompter: this.shared.prompter.quiet(),
        }),
      peer.remoteRoot,
      name,
      () => this.nudge(),
      {
        sessionId: `tether-${crypto
          .createHash('sha1')
          .update(`${peer.ref.target}\0${peer.remoteRoot}\0${n}`)
          .digest('hex')
          .slice(0, 10)}`,
        log: (m) => this.shared.log.info(m),
      },
    );
    this.remoteTerminals.push(handle);
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t !== handle.terminal) return;
        const i = this.remoteTerminals.indexOf(handle);
        if (i >= 0) this.remoteTerminals.splice(i, 1);
      }),
    );
    handle.terminal.show();
  }

  private async pickTerminalPeer(): Promise<RemotePeer | undefined> {
    const live = this.livePeers();
    if (live.length === 0) return this.peers[0];
    if (live.length === 1) return live[0];

    type Item = vscode.QuickPickItem & { peer: RemotePeer };
    const items: Item[] = live.map((peer) => ({
      label: `$(terminal) ${peer.ref.target}`,
      description: peer.remoteRoot || peer.ref.remoteDir,
      peer,
    }));
    const preferred = this.lastTerminalTarget
      ? items.find((i) => i.peer.ref.target === this.lastTerminalTarget)
      : undefined;
    if (preferred) {
      items.splice(items.indexOf(preferred), 1);
      items.unshift({ ...preferred, description: `${preferred.description ?? ''} · last used`.trim() });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Tether: which server for the terminal?',
      placeHolder: 'Remote Terminal',
      ignoreFocusOut: true,
    });
    return picked?.peer;
  }

  async forwardPort(remotePort: number): Promise<number> {
    let peer = this.peers[0];
    if (this.livePeers().length > 1) {
      const picked = await this.pickTerminalPeer();
      if (!picked) throw new Error('Cancelled');
      peer = picked;
    }
    const server = net.createServer((socket) => {
      const conn = peer.conn;
      if (!conn || conn.closed) return socket.destroy();
      conn
        .forward('127.0.0.1', remotePort)
        .then((stream) => {
          socket.pipe(stream).pipe(socket);
          socket.on('error', () => stream.destroy());
          stream.on('error', () => socket.destroy());
        })
        .catch(() => socket.destroy());
    });
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
      });
    const localPort = await listen(remotePort).catch(() => listen(0));
    this.forwards.push(server);
    return localPort;
  }

  /** Peer used for a port forward message (last pick or primary). */
  forwardPeerLabel(): string {
    return this.lastTerminalTarget || this.binding.target;
  }

  private setState(state: SessionState, detail = ''): void {
    this.state = state;
    this.detail = detail;
    this.changed.fire();
  }
}

/** Skip virtual Remote View folders when iterating workspace folders. */
export function isLocalWorkspaceFolder(folder: vscode.WorkspaceFolder): boolean {
  return folder.uri.scheme !== TETHER_SCHEME;
}
