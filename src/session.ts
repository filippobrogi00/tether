import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { Binding, Bindings } from './bindings';
import { Connection, UserCancelled } from './core/connection';
import { DEFAULT_IGNORES, IgnoreRules } from './core/ignore';
import { KnownHosts } from './core/knownHosts';
import { SyncEngine } from './core/syncEngine';
import { ConflictPolicy, Logger, SyncResult } from './core/types';
import { VscodePrompter } from './prompter';
import { TETHER_SCHEME } from './remoteFs';
import { confirmRemoteTerminals, openRemoteTerminal, RemoteTerminalHandle } from './terminal';

export type SessionState = 'connecting' | 'syncing' | 'idle' | 'conflicts' | 'error' | 'offline' | 'paused' | 'stopped';

/** Per-file sync status for the status bar / tooltip. */
export type FileSyncStatus = 'pending' | 'syncing' | 'error';

export interface Shared {
  context: vscode.ExtensionContext;
  log: Logger;
  prompter: VscodePrompter;
  knownHosts: KnownHosts;
  bindings: Bindings;
}

const DEBOUNCE_MS = 350;
const RETRY_DELAYS_S = [3, 5, 10, 20, 40, 60];

/**
 * One local folder kept in sync with one folder on one server.
 * Owns the connection, the file watcher, the timers and the reconnect logic.
 */
export class Session implements vscode.Disposable {
  state: SessionState = 'stopped';
  /** Short human-readable note for the status bar tooltip (progress or last problem). */
  detail = '';
  lastSync?: Date;
  conn?: Connection;
  engine?: SyncEngine;
  remoteRoot = '';
  /** Paths currently dirty, in flight, or failed on the last sync attempt. */
  readonly fileStatus = new Map<string, FileSyncStatus>();
  /** Keep-alive remote terminals opened for this pairing. */
  readonly remoteTerminals: RemoteTerminalHandle[] = [];

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
  private terminalSeq = 0;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    readonly binding: Binding,
    private readonly shared: Shared,
  ) {}

  get localRoot(): string {
    return this.folder.uri.fsPath;
  }

  private config<T>(key: string, fallback: T): T {
    const tether = vscode.workspace.getConfiguration('tether', this.folder.uri);
    const inspected = tether.inspect<T>(key);
    if (
      inspected?.workspaceFolderValue !== undefined ||
      inspected?.workspaceValue !== undefined ||
      inspected?.globalValue !== undefined
    ) {
      return tether.get<T>(key, fallback);
    }
    // Fall back to legacy Connect Light settings if the user never migrated.
    return vscode.workspace.getConfiguration('connectLight', this.folder.uri).get<T>(key, fallback);
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Connect (or adopt an already-open connection from the wizard) and start syncing.
   * `interactive` = allowed to show password / host key prompts.
   */
  async start(interactive: boolean, existing?: Connection): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.retryTimer);
    this.setState('connecting', `Connecting to ${this.binding.target}…`);
    try {
      const conn =
        existing ??
        (await Connection.open(this.binding.target, {
          log: this.shared.log,
          knownHosts: this.shared.knownHosts,
          prompter: interactive ? this.shared.prompter : this.shared.prompter.quiet(),
        }));
      if (this.disposed) return conn.close();
      void this.shared.prompter.offerToSave();
      this.conn = conn;
      this.retries = 0;
      conn.once('close', () => this.onConnectionLost(conn));

      this.remoteRoot = conn.resolvePath(this.binding.remoteDir);
      if (this.engine) this.engine.setConnection(conn);
      else this.engine = this.createEngine(conn);
      await this.engine.init();

      this.startWatching();
      await this.preferUnixLineEndings();
      this.pending.clear(); // the full sync below covers anything queued while offline
      this.shared.log.info(`Connected: ${this.localRoot}  <->  ${this.binding.target}:${this.remoteRoot}`);
      // Closing the editor stops sync; reopening this folder should resume automatically.
      this.binding.resumeOnOpen = true;
      await this.shared.bindings.set(this.localRoot, this.binding);
      await this.fullSync();
      this.startPolling();
    } catch (err) {
      this.handleConnectFailure(err as Error, interactive);
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
      return; // do not nag: wait for the user
    }
    this.shared.log.error(err.message);
    this.setState('offline', err.message);
    if (interactive) {
      void vscode.window.showErrorMessage(`Tether: ${err.message}`, 'Retry', 'Show Log').then((choice) => {
        if (choice === 'Retry') void this.start(true);
        if (choice === 'Show Log') void vscode.commands.executeCommand('tether.showLog');
      });
    } else {
      this.scheduleRetry();
    }
  }

  private onConnectionLost(conn: Connection): void {
    if (this.disposed || this.conn !== conn || this.state === 'stopped') return;
    this.shared.log.warn('Connection lost. You can keep editing; changes sync when the connection is back.');
    clearInterval(this.pollTimer);
    this.setState('offline', 'Connection lost. Reconnecting…');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_S[Math.min(this.retries++, RETRY_DELAYS_S.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.start(false), delay * 1000);
  }

  /**
   * Stop syncing and disconnect, but remember the pairing.
   * Also opts out of auto-resume on the next open (unlike closing the editor).
   */
  async stop(): Promise<void> {
    await this.promptAndCloseTerminals();
    this.clearTimers();
    this.binding.resumeOnOpen = false;
    void this.shared.bindings.set(this.localRoot, this.binding);
    this.setState('stopped', 'Disconnected');
    this.conn?.close();
    this.conn = undefined;
  }

  /** Ask Terminate / Keep alive for any tmux/screen sessions, then clear the list. */
  async promptAndCloseTerminals(): Promise<void> {
    const handles = [...this.remoteTerminals];
    this.remoteTerminals.length = 0;
    if (handles.length) await confirmRemoteTerminals(handles);
  }

  pause(): void {
    if (this.state === 'stopped' || this.state === 'offline') return;
    clearInterval(this.pollTimer);
    this.pending.clear();
    for (const [path, st] of this.fileStatus) {
      if (st === 'pending' || st === 'syncing') this.fileStatus.delete(path);
    }
    this.setState('paused', 'Paused. Nothing is copied in either direction.');
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    this.state = 'idle';
    await this.fullSync();
    this.startPolling();
  }

  /** Counts of paths still waiting or in flight (for the status bar). */
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
    // Terminals should already have been prompted; detach any leftovers.
    for (const h of this.remoteTerminals) h.detach();
    this.remoteTerminals.length = 0;
    this.conn?.close();
    this.changed.dispose();
  }

  private clearTimers(): void {
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.nudgeTimer);
    clearInterval(this.pollTimer);
  }

  // ---- engine wiring -------------------------------------------------------

  private createEngine(conn: Connection): SyncEngine {
    const session = this;
    const storage = this.shared.context.globalStorageUri.fsPath;
    const id = crypto.createHash('sha1').update(this.localRoot).digest('hex').slice(0, 16);
    return new SyncEngine(conn, {
      localRoot: this.localRoot,
      remoteRoot: this.remoteRoot,
      manifestFile: path.join(storage, 'manifests', `${id}.json`),
      log: this.shared.log,
      sshTarget: this.binding.target,
      loadIgnore: () =>
        IgnoreRules.load(
          this.localRoot,
          this.config<string[]>('ignore', DEFAULT_IGNORES),
          this.config('respectGitignore', false),
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
      confirmDeletes: async (count, sample) => {
        const go = `Delete ${count} Files`;
        const choice = await vscode.window.showWarningMessage(
          `Tether is about to delete ${count} files to mirror deletions from the other side.`,
          { modal: true, detail: `For example:\n${sample.join('\n')}\n\nChoose Cancel to pause syncing and review.` },
          go,
        );
        return choice === go;
      },
      onProgress: (done, total) => {
        if (total > 3) {
          this.detail = `Syncing ${done}/${total}`;
          this.changed.fire();
        }
      },
    });
  }

  private usable(): boolean {
    return !!this.engine && !!this.conn && !this.conn.closed && this.state !== 'paused' && this.state !== 'stopped';
  }

  /** Scan both sides and reconcile. Safe to call at any time; runs are queued. */
  async fullSync(): Promise<void> {
    if (!this.usable() || this.state === 'offline') return;
    await this.run(() => this.engine!.reconcile());
  }

  private async run(job: () => Promise<SyncResult>, paths?: string[]): Promise<void> {
    this.busy++;
    if (paths) for (const p of paths) this.fileStatus.set(p, 'syncing');
    this.setState('syncing', paths?.length ? `Syncing ${paths.length} file(s)…` : this.detail || 'Syncing…');
    try {
      this.report(await job(), paths);
      this.lastSync = new Date();
    } catch (err) {
      this.shared.log.error(`Sync failed: ${(err as Error).message}`);
      this.lastSyncHadErrors = true;
      this.detail = `Last sync failed: ${(err as Error).message}`;
      if (paths) for (const p of paths) this.fileStatus.set(p, 'error');
    } finally {
      this.busy--;
      if (this.busy === 0 && (this.state === 'syncing' || this.state === 'error')) this.settle();
    }
  }

  private settle(): void {
    const n = this.engine?.conflicts.size ?? 0;
    if (n > this.knownConflicts) {
      void vscode.window
        .showWarningMessage(
          n === 1
            ? 'Tether: 1 file was changed both here and on the server.'
            : `Tether: ${n} files were changed both here and on the server.`,
          'Review',
        )
        .then((c) => c && vscode.commands.executeCommand('tether.resolveConflicts'));
    }
    this.knownConflicts = n;

    if (this.pending.size > 0 || this.pendingCount() > 0) {
      this.setState('syncing', `${this.pending.size || this.pendingCount()} change(s) queued`);
      return;
    }
    if (n > 0) this.setState('conflicts', `${n} file(s) need your decision`);
    else if (this.lastSyncHadErrors) this.setState('error', this.detail || 'Sync failed for one or more files');
    else this.setState('idle', '');
  }

  refresh(): void {
    if (this.busy === 0 && (this.state === 'conflicts' || this.state === 'idle' || this.state === 'error')) this.settle();
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
    const signature = res.errors.map((e) => e.path).sort().join('\n');
    const isNew = signature !== this.lastErrors;
    this.lastErrors = signature;
    this.lastSyncHadErrors = res.errors.length > 0;
    if (res.errors.length) this.detail = `Last sync failed for ${res.errors.length} file(s)`;
    else {
      for (const [p, st] of [...this.fileStatus]) {
        if (st === 'error' && !this.pending.has(p)) this.fileStatus.delete(p);
      }
    }
    if (res.errors.length && isNew && !this.conn?.closed) {
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
    this.pending.add(posix);
    this.fileStatus.set(posix, 'pending');
    if (this.usable() && this.state !== 'offline' && this.state !== 'connecting' && this.state !== 'paused') {
      this.setState('syncing', `${this.pending.size} change(s) queued`);
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (!this.usable() || this.state === 'offline' || this.state === 'connecting') {
      return;
    }
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length) await this.run(() => this.engine!.pushPaths(paths), paths);
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

  /** Something probably changed on the server (a command just ran): check soon. */
  nudge(): void {
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => void this.fullSync(), 3000);
  }

  // ---- features built on the connection --------------------------------------

  openTerminal(): void {
    this.terminalSeq++;
    const suffix = this.terminalSeq > 1 ? ` #${this.terminalSeq}` : '';
    const name = `${this.binding.target} (server)${suffix}`;
    const handle = openRemoteTerminal(
      () => this.conn,
      this.remoteRoot,
      name,
      () => this.nudge(),
      {
        sessionId: `tether-${crypto.createHash('sha1').update(`${this.binding.target}\0${this.remoteRoot}\0${this.terminalSeq}`).digest('hex').slice(0, 10)}`,
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

  /** Make a port on the server reachable as localhost:<port> on this machine. */
  async forwardPort(remotePort: number): Promise<number> {
    const server = net.createServer((socket) => {
      const conn = this.conn;
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
