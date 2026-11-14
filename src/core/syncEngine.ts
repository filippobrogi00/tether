import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { tryArchiveBootstrap } from './bootstrap';
import { getCompressed, putCompressed, rsyncPath } from './compress';
import { Connection, dirname, joinPosix } from './connection';
import { IgnoreRules } from './ignore';
import { loadManifest, saveManifest } from './manifest';
import { plan } from './planner';
import { mapLimit, scanLocal, scanRemote, shellQuote, statLocal } from './scan';
import {
  Action,
  Conflict,
  ConflictChoice,
  ConflictPolicy,
  FileMap,
  FileStat,
  Logger,
  Manifest,
  SyncResult,
} from './types';

export interface EngineOptions {
  localRoot: string;
  /** Absolute path on the server (use Connection.resolvePath first). */
  remoteRoot: string;
  manifestFile: string;
  /** Called before every full sync so edits to ignore files/settings apply without reconnecting. */
  loadIgnore: () => IgnoreRules;
  /** Bytes; 0 disables the limit. */
  maxFileSize: number;
  concurrency: number;
  conflictPolicy: ConflictPolicy;
  /** Ask before a single sync deletes more than this many files. */
  confirmDeletesOver: number;
  log: Logger;
  /** Gzip payloads above a size threshold when the server has gzip. */
  compressTransfers?: boolean;
  /** SSH target alias (user@host or config Host) for optional rsync. */
  sshTarget?: string;
  /** Override local deletion (the extension sends files to the OS trash). */
  removeLocal?: (abs: string) => Promise<void>;
  confirmDeletes?: (count: number, sample: string[]) => Promise<boolean>;
  onProgress?: (done: number, total: number) => void;
}

/** Above this many changed paths, a full reconcile is cheaper than per-file checks. */
const FAST_PATH_LIMIT = 300;

export class SyncEngine {
  /** Files that need a human decision (only filled when conflictPolicy is "ask"). */
  readonly conflicts = new Map<string, Conflict>();
  private base: Manifest = new Map();
  private ig: IgnoreRules;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly posixLocal = process.platform !== 'win32';

  constructor(
    private conn: Connection,
    private readonly o: EngineOptions,
  ) {
    this.ig = o.loadIgnore();
  }

  private get key(): string {
    return `${this.conn.host.user}@${this.conn.host.hostName}:${this.conn.host.port}:${this.o.remoteRoot}`;
  }

  /** Swap in a fresh connection after a reconnect; all sync state is kept. */
  setConnection(conn: Connection): void {
    this.conn = conn;
  }

  async init(): Promise<void> {
    this.base = loadManifest(this.o.manifestFile, this.key);
    await fs.promises.mkdir(this.o.localRoot, { recursive: true });
    await this.conn.mkdirp(this.o.remoteRoot);
  }

  get trackedCount(): number {
    return this.base.size;
  }

  /** Full two-way sync: scan both sides, reconcile against the manifest, apply. */
  reconcile(): Promise<SyncResult> {
    return this.serial(async () => {
      this.ig = this.o.loadIgnore();
      // A root that vanished (unmounted disk, renamed folder) must never be read as "everything was deleted".
      if (!fs.existsSync(this.o.localRoot)) throw new Error(`The local folder ${this.o.localRoot} no longer exists.`);
      if (!(await this.conn.stat(this.o.remoteRoot))?.isDir) {
        throw new Error(`The folder ${this.o.remoteRoot} no longer exists on the server.`);
      }
      const [l, r] = await Promise.all([
        scanLocal(this.o.localRoot, this.ig, this.o.maxFileSize),
        scanRemote(this.conn, this.o.remoteRoot, this.ig, this.o.maxFileSize, this.o.log),
      ]);
      const skipped = new Set([...l.skipped, ...r.skipped]);
      const actions = plan({
        local: l.files,
        remote: r.files,
        base: this.base,
        skipped,
        isIgnored: (p) => this.ig.ignoresPath(p),
      });
      this.conflicts.clear();
      // One side suddenly holding no files at all is suspicious: always ask, whatever the threshold.
      const emptied = this.base.size > 0 && (l.files.size === 0 || r.files.size === 0);
      return this.execute(actions, l.files, r.files, [...skipped], emptied);
    });
  }

  /**
   * Fast path after local edits: look only at the given paths (files or folders,
   * relative POSIX). Each one is still checked against the server before being
   * overwritten, so a concurrent remote edit becomes a conflict, not data loss.
   */
  pushPaths(rels: string[]): Promise<SyncResult> {
    if (rels.length > FAST_PATH_LIMIT) return this.reconcile();
    return this.serial(async () => {
      const candidates = new Set<string>();
      for (const rel of rels) {
        if (!rel || this.ig.ignoresPath(rel) || this.ig.ignores(rel, true)) continue;
        let st: fs.Stats | undefined;
        try {
          st = await fs.promises.stat(path.join(this.o.localRoot, rel));
        } catch {
          st = undefined;
        }
        if (st?.isDirectory()) {
          const sub = await scanLocal(this.o.localRoot, this.ig, this.o.maxFileSize, rel);
          for (const p of sub.files.keys()) candidates.add(p);
        } else if (st?.isFile()) {
          candidates.add(rel);
        } else {
          // Gone locally: the path itself and anything we track underneath it.
          if (this.base.has(rel)) candidates.add(rel);
          const prefix = rel + '/';
          for (const p of this.base.keys()) if (p.startsWith(prefix)) candidates.add(p);
        }
      }

      const local: FileMap = new Map();
      const skipped = new Set<string>();
      for (const p of [...candidates]) {
        const st = await statLocal(this.localAbs(p));
        if (st && this.o.maxFileSize > 0 && st.size > this.o.maxFileSize) {
          skipped.add(p);
        } else if (st) {
          const b = this.base.get(p);
          // Unchanged since the last sync (e.g. the echo of our own download): nothing to do.
          if (b && b.l.size === st.size && b.l.mtime === st.mtime) candidates.delete(p);
          else local.set(p, st);
        }
      }
      if (candidates.size === 0) return emptyResult();

      const remote: FileMap = new Map();
      await mapLimit(candidates, this.o.concurrency, async (p) => {
        const st = await this.conn.stat(this.remoteAbs(p));
        if (st && !st.isDir) remote.set(p, { size: st.size, mtime: st.mtime, mode: st.mode });
      });

      for (const p of candidates) this.conflicts.delete(p);
      const actions = plan({ local, remote, base: this.base, skipped, only: candidates });
      return this.execute(actions, local, remote, [...skipped]);
    });
  }

  /** Apply the user's decision for one conflicted file. */
  resolveConflict(rel: string, choice: ConflictChoice): Promise<void> {
    return this.serial(async () => {
      const l = await statLocal(this.localAbs(rel));
      const rs = await this.conn.stat(this.remoteAbs(rel));
      const r = rs && !rs.isDir ? rs : undefined;

      if (choice === 'both' && l && r) {
        // Keep the server's version next to the local one, then publish the local one.
        const copy = await this.freeConflictName(rel);
        await this.conn.get(this.remoteAbs(rel), this.localAbs(copy));
        await this.upload(rel, r);
      } else if (choice === 'local' || (choice === 'both' && l)) {
        if (l) await this.upload(rel, r);
        else await this.deleteRemote(rel, true);
      } else {
        if (r) await this.download(rel);
        else await this.deleteLocal(rel, true);
      }
      this.conflicts.delete(rel);
      await this.save();
    });
  }

  /** Fetch the server's copy of a file to an arbitrary local path (used for diff views). */
  async downloadCopy(rel: string, destAbs: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(destAbs), { recursive: true });
    await this.conn.get(this.remoteAbs(rel), destAbs);
  }

  /**
   * After a Remote View DnD write/read that already put bytes in place, refresh
   * the three-way record so the continuous sync watcher does not re-transfer.
   */
  async noteSynced(rel: string): Promise<void> {
    const l = await statLocal(this.localAbs(rel));
    const rs = await this.conn.stat(this.remoteAbs(rel));
    if (l && rs && !rs.isDir) {
      this.base.set(rel, { l, r: { size: rs.size, mtime: rs.mtime, mode: rs.mode } });
      await this.save();
    }
  }

  /** Relative POSIX path under the synced roots, or undefined if outside. */
  toRel(absOrRemote: string, side: 'local' | 'remote'): string | undefined {
    if (side === 'local') {
      const rel = path.relative(this.o.localRoot, absOrRemote);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
      return rel.split(path.sep).join('/');
    }
    const root = this.o.remoteRoot.replace(/\/+$/, '');
    if (absOrRemote !== root && !absOrRemote.startsWith(root + '/')) return undefined;
    return absOrRemote === root ? '' : absOrRemote.slice(root.length + 1);
  }

  // ---- execution -----------------------------------------------------------

  private async execute(
    planned: Action[],
    local: FileMap,
    remote: FileMap,
    skippedLarge: string[],
    alwaysConfirmDeletes = false,
  ): Promise<SyncResult> {
    const result = emptyResult();
    result.skippedLarge = skippedLarge;
    let actions = planned.filter((a) => a.kind !== 'verify');

    // 1. Files present on both sides with no history: identical content means "already in sync".
    const toVerify = planned.filter((a) => a.kind === 'verify').map((a) => a.path);
    if (toVerify.length) {
      const identical = await this.identicalContent(toVerify);
      for (const p of toVerify) {
        if (identical === undefined || identical.has(p)) {
          this.base.set(p, { l: local.get(p)!, r: remote.get(p)! });
        } else {
          actions.push({ kind: 'conflict', path: p, reason: 'both-new' });
        }
      }
    }

    // Cold first sync: one compressed archive instead of hundreds of SFTP round-trips.
    if (this.base.size === 0) {
      const bootstrapped = await tryArchiveBootstrap(this.conn, {
        localRoot: this.o.localRoot,
        remoteRoot: this.o.remoteRoot,
        actions: planned,
        log: this.o.log,
      });
      if (bootstrapped) {
        const [l2, r2] = await Promise.all([
          scanLocal(this.o.localRoot, this.ig, this.o.maxFileSize),
          scanRemote(this.conn, this.o.remoteRoot, this.ig, this.o.maxFileSize, this.o.log),
        ]);
        for (const [p, lst] of l2.files) {
          const rst = r2.files.get(p);
          if (rst) this.base.set(p, { l: lst, r: rst });
        }
        const uploads = planned.filter((a) => a.kind === 'upload').length;
        const downloads = planned.filter((a) => a.kind === 'download').length;
        if (uploads) result.uploaded = uploads;
        if (downloads) result.downloaded = downloads;
        await this.save();
        return result;
      }
    }

    // 2. Conflicts: park them for the user, or settle them by policy.
    const work: { path: string; run: () => Promise<unknown> }[] = [];
    const count = (k: 'uploaded' | 'downloaded' | 'deletedLocal' | 'deletedRemote') => () => void result[k]++;
    for (const a of actions) {
      if (a.kind !== 'conflict') continue;
      const l = local.get(a.path);
      const r = remote.get(a.path);
      const policy = this.o.conflictPolicy;
      if (policy === 'ask') {
        this.conflicts.set(a.path, { path: a.path, reason: a.reason, local: l, remote: r });
        result.conflicts++;
        continue;
      }
      this.o.log.warn(`Conflict on ${a.path} (${a.reason}) settled by policy "${policy}".`);
      if (policy === 'keepBoth' && l && r) {
        work.push({
          path: a.path,
          run: async () => {
            const copy = await this.freeConflictName(a.path);
            await this.conn.get(this.remoteAbs(a.path), this.localAbs(copy));
            await this.upload(a.path, r).then(count('uploaded'));
          },
        });
      } else if (policy === 'preferLocal' || (policy === 'keepBoth' && l)) {
        work.push({
          path: a.path,
          run: () => (l ? this.upload(a.path, r).then(count('uploaded')) : this.deleteRemote(a.path, true).then(count('deletedRemote'))),
        });
      } else {
        work.push({
          path: a.path,
          run: () => (r ? this.download(a.path).then(count('downloaded')) : this.deleteLocal(a.path, true).then(count('deletedLocal'))),
        });
      }
    }
    actions = actions.filter((a) => a.kind !== 'conflict');

    // 3. Guard against mass deletion (wrong folder picked, unmounted disk, ...).
    const deletes = actions.filter((a) => a.kind === 'deleteLocal' || a.kind === 'deleteRemote');
    const limit = alwaysConfirmDeletes ? 0 : this.o.confirmDeletesOver;
    if (deletes.length > limit && this.o.confirmDeletes) {
      const ok = await this.o.confirmDeletes(deletes.length, deletes.slice(0, 8).map((d) => d.path));
      if (!ok) {
        actions = actions.filter((a) => a.kind !== 'deleteLocal' && a.kind !== 'deleteRemote');
        result.deletesDeclined = true;
      }
    }

    // 4. Transfers.
    for (const a of actions) {
      switch (a.kind) {
        case 'upload':
          work.push({ path: a.path, run: () => this.upload(a.path, remote.get(a.path)).then(count('uploaded')) });
          break;
        case 'download':
          work.push({ path: a.path, run: () => this.download(a.path).then(count('downloaded')) });
          break;
        case 'deleteRemote':
          work.push({ path: a.path, run: () => this.deleteRemote(a.path, false).then((ok) => void (ok && result.deletedRemote++)) });
          break;
        case 'deleteLocal':
          work.push({ path: a.path, run: () => this.deleteLocal(a.path, false).then((ok) => void (ok && result.deletedLocal++)) });
          break;
        case 'forget':
          this.base.delete(a.path);
          break;
      }
    }

    let done = 0;
    this.o.onProgress?.(0, work.length);
    await mapLimit(work, this.o.concurrency, async (job) => {
      if (this.conn.closed) {
        result.errors.push({ path: job.path, message: 'Connection lost' });
        return;
      }
      try {
        await job.run();
      } catch (err) {
        result.errors.push({ path: job.path, message: (err as Error).message });
      }
      this.o.onProgress?.(++done, work.length);
      if (done % 200 === 0) await this.save().catch(() => undefined);
    });

    await this.save();
    return result;
  }

  private async upload(rel: string, existingRemote?: FileStat): Promise<void> {
    const abs = this.localAbs(rel);
    const before = await statLocal(abs);
    if (!before) return; // vanished between scan and transfer; the next pass handles it
    const target = this.remoteAbs(rel);
    await this.conn.mkdirp(dirname(target));

    if (this.o.sshTarget && (await rsyncPath(this.conn, 'upload', abs, target, this.o.sshTarget, this.o.log))) {
      const after = await this.conn.stat(target);
      if (!after) throw new Error('Upload finished but the file is missing on the server');
      this.base.set(rel, { l: before, r: { size: after.size, mtime: after.mtime, mode: after.mode } });
      return;
    }

    const tmp = tempName(target, '/');
    try {
      const useCompress = this.o.compressTransfers !== false;
      const compressed = useCompress && (await putCompressed(this.conn, abs, tmp, before.size, this.o.log));
      if (!compressed) await this.conn.put(abs, tmp);
      // Keep the server's permissions for existing files; Windows has no meaningful mode bits.
      const mode = existingRemote?.mode ?? (this.posixLocal ? before.mode : 0o644);
      if (mode !== undefined) await this.conn.chmod(tmp, mode);
      await this.conn.rename(tmp, target); // atomic: the server never sees a half-written file
    } catch (err) {
      await this.conn.unlink(tmp).catch(() => undefined);
      throw err;
    }
    const after = await this.conn.stat(target);
    if (!after) throw new Error('Upload finished but the file is missing on the server');
    this.base.set(rel, { l: before, r: { size: after.size, mtime: after.mtime, mode: after.mode } });
  }

  private async download(rel: string): Promise<void> {
    const source = this.remoteAbs(rel);
    const before = await this.conn.stat(source);
    if (!before || before.isDir) return;
    const abs = this.localAbs(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });

    if (this.o.sshTarget && (await rsyncPath(this.conn, 'download', abs, source, this.o.sshTarget, this.o.log))) {
      const after = await statLocal(abs);
      if (!after) throw new Error('Download finished but the local file is missing');
      this.base.set(rel, { l: after, r: { size: before.size, mtime: before.mtime, mode: before.mode } });
      return;
    }

    const tmp = tempName(abs, path.sep);
    try {
      const useCompress = this.o.compressTransfers !== false;
      const compressed = useCompress && (await getCompressed(this.conn, source, tmp, before.size, this.o.log));
      if (!compressed) await this.conn.get(source, tmp);
      if (this.posixLocal && before.mode !== undefined) await fs.promises.chmod(tmp, before.mode & 0o777);
      await fs.promises.rename(tmp, abs);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    const after = await statLocal(abs);
    if (!after) throw new Error('Download finished but the local file is missing');
    this.base.set(rel, { l: after, r: { size: before.size, mtime: before.mtime, mode: before.mode } });
  }

  /** Returns false when the deletion was skipped because the file changed in the meantime. */
  private async deleteRemote(rel: string, force: boolean): Promise<boolean> {
    const target = this.remoteAbs(rel);
    const b = this.base.get(rel);
    if (!force && b) {
      const now = await this.conn.stat(target);
      if (now && (now.size !== b.r.size || now.mtime !== b.r.mtime)) return false; // edited remotely: becomes a conflict next pass
    }
    await this.conn.unlink(target);
    this.base.delete(rel);
    for (let dir = dirname(target); dir.startsWith(this.o.remoteRoot + '/'); dir = dirname(dir)) {
      if (!(await this.conn.rmdirIfEmpty(dir))) break;
    }
    return true;
  }

  private async deleteLocal(rel: string, force: boolean): Promise<boolean> {
    const abs = this.localAbs(rel);
    const b = this.base.get(rel);
    const now = await statLocal(abs);
    if (!force && b && now && (now.size !== b.l.size || now.mtime !== b.l.mtime)) return false;
    if (now) await (this.o.removeLocal ?? ((p: string) => fs.promises.rm(p, { force: true })))(abs);
    this.base.delete(rel);
    const root = path.resolve(this.o.localRoot);
    for (let dir = path.dirname(abs); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try {
        await fs.promises.rmdir(dir); // only succeeds when empty
      } catch {
        break;
      }
    }
    return true;
  }

  // ---- content comparison --------------------------------------------------

  /**
   * Which of these paths have byte-identical content on both sides?
   * Hashing happens on the server (sha256sum/shasum) so nothing is transferred.
   * Returns undefined when the server cannot hash; callers then trust equal sizes.
   */
  private async identicalContent(rels: string[]): Promise<Set<string> | undefined> {
    const cmd = await this.hashCommand();
    if (!cmd) {
      this.o.log.warn(`Server has no sha256sum/shasum; treating ${rels.length} same-size file(s) as identical.`);
      return undefined;
    }
    const remoteHashes = new Map<string, string>();
    const input = Buffer.from(rels.map((p) => './' + p).join('\0') + '\0');
    const { stdout } = await this.conn.exec(`cd -- ${shellQuote(this.o.remoteRoot)} && xargs -0 ${cmd}`, input);
    for (const line of stdout.toString('utf8').split('\n')) {
      const m = /^([0-9a-f]{64}) [ *]\.\/(.*)$/.exec(line);
      if (m) remoteHashes.set(m[2], m[1]);
    }
    const same = new Set<string>();
    await mapLimit(rels, 4, async (p) => {
      const want = remoteHashes.get(p);
      if (want && want === (await hashLocal(this.localAbs(p)).catch(() => ''))) same.add(p);
    });
    return same;
  }

  private async hashCommand(): Promise<string | null> {
    if (this.conn.caps.hashCmd !== undefined) return this.conn.caps.hashCmd;
    let found: string | null = null;
    for (const [probe, cmd] of [
      ['sha256sum --version', 'sha256sum'],
      ['shasum -a 256 /dev/null', 'shasum -a 256'],
    ]) {
      try {
        if ((await this.conn.exec(`${probe} >/dev/null 2>&1`)).code === 0) {
          found = cmd;
          break;
        }
      } catch {
        break; // no shell access at all (SFTP-only account)
      }
    }
    return (this.conn.caps.hashCmd = found);
  }

  // ---- small helpers -------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private save(): Promise<void> {
    return saveManifest(this.o.manifestFile, this.key, this.base);
  }

  private localAbs(rel: string): string {
    return path.join(this.o.localRoot, ...rel.split('/'));
  }

  private remoteAbs(rel: string): string {
    return joinPosix(this.o.remoteRoot, rel);
  }

  /** "notes.txt" -> "notes.server-copy.txt" (numbered if that already exists). */
  private async freeConflictName(rel: string): Promise<string> {
    const slash = rel.lastIndexOf('/');
    const dir = slash < 0 ? '' : rel.slice(0, slash + 1);
    const name = rel.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${dir}${stem}.server-copy${i > 1 ? '-' + i : ''}${ext}`;
      if (!(await statLocal(this.localAbs(candidate)))) return candidate;
    }
  }
}

function emptyResult(): SyncResult {
  return { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, errors: [], skippedLarge: [] };
}

/** Hidden sibling temp file; the name matches TEMP_PATTERN so scanners ignore it. */
function tempName(target: string, sep: string): string {
  const i = target.lastIndexOf(sep);
  const id = crypto.randomBytes(4).toString('hex');
  return `${target.slice(0, i + 1)}.${target.slice(i + 1)}.${id}.tether-tmp`;
}

function hashLocal(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
