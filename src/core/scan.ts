import * as fs from 'fs';
import * as path from 'path';
import { Connection, joinPosix } from './connection';
import { IgnoreRules } from './ignore';
import { FileMap, FileStat, Logger } from './types';

export interface ScanResult {
  files: FileMap;
  /** Files over the size limit: reported, never synced, never deleted. */
  skipped: Set<string>;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(items: Iterable<T>, limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const it = items[Symbol.iterator]();
  const worker = async () => {
    for (let n = it.next(); !n.done; n = it.next()) await fn(n.value);
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function statLocal(abs: string): Promise<FileStat | undefined> {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return undefined;
    return { size: st.size, mtime: Math.round(st.mtimeMs), mode: st.mode & 0o777 };
  } catch {
    return undefined;
  }
}

// ---- local -----------------------------------------------------------------

export async function scanLocal(root: string, ig: IgnoreRules, maxSize: number, prefix = ''): Promise<ScanResult> {
  const files: FileMap = new Map();
  const skipped = new Set<string>();

  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return; // unreadable or vanished folder
    }
    const subdirs: string[] = [];
    await mapLimit(entries, 32, async (e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ig.ignores(r, true)) subdirs.push(r);
      } else if (e.isFile() && !ig.ignores(r)) {
        const st = await statLocal(path.join(root, r));
        if (!st) return;
        if (maxSize > 0 && st.size > maxSize) skipped.add(r);
        else files.set(r, st);
      }
      // Symlinks are intentionally not followed or copied in this version.
    });
    for (const d of subdirs) await walk(d);
  };

  await walk(prefix);
  return { files, skipped };
}

// ---- remote ----------------------------------------------------------------

/**
 * List every file under `root` on the server.
 *
 * Fast path: one `find` command (GNU find, i.e. practically every Linux server),
 * which lists hundreds of thousands of files in a single round trip.
 * Fallback: walk the tree over SFTP, which works on any SSH server at all,
 * including BSD/macOS hosts and SFTP-only accounts with no shell.
 */
export async function scanRemote(
  conn: Connection,
  root: string,
  ig: IgnoreRules,
  maxSize: number,
  log: Logger,
): Promise<ScanResult> {
  if (conn.caps.find !== false) {
    try {
      const result = await scanWithFind(conn, root, ig, maxSize);
      if (result) {
        conn.caps.find = true;
        return result;
      }
    } catch (err) {
      log.info(`Fast remote listing unavailable (${(err as Error).message}); using SFTP listing.`);
    }
    if (conn.caps.find === undefined) conn.caps.find = false;
  }
  return scanWithSftp(conn, root, ig, maxSize);
}

/** `find` fragment that skips ignored directories. Empty when there is nothing to prune. */
export function findPruneExpr(ig: Pick<IgnoreRules, 'pruneNames' | 'pruneRoots'>): string {
  const clauses = [
    ...ig.pruneNames.map((n) => `-name ${shellQuote(n)}`),
    ...ig.pruneRoots.map((n) => `-path ${shellQuote('./' + n)}`),
  ];
  return clauses.length ? `\\( ${clauses.join(' -o ')} \\) -prune -o ` : '';
}

async function scanWithFind(conn: Connection, root: string, ig: IgnoreRules, maxSize: number): Promise<ScanResult | undefined> {
  const prune = findPruneExpr(ig);
  const cmd = `cd -- ${shellQuote(root)} && find . ${prune}-type f -printf '%s\\t%T@\\t%m\\t%P\\0'`;
  const { code, stdout } = await conn.exec(cmd);
  if (code !== 0) return undefined;

  const files: FileMap = new Map();
  const skipped = new Set<string>();
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf(0, start);
    if (end < 0) end = stdout.length;
    const record = stdout.toString('utf8', start, end);
    start = end + 1;
    const t1 = record.indexOf('\t');
    const t2 = record.indexOf('\t', t1 + 1);
    const t3 = record.indexOf('\t', t2 + 1);
    if (t1 < 0 || t2 < 0 || t3 < 0) continue;
    const rel = record.slice(t3 + 1);
    if (!rel || ig.ignoresPath(rel)) continue;
    const size = Number(record.slice(0, t1));
    if (maxSize > 0 && size > maxSize) {
      skipped.add(rel);
      continue;
    }
    files.set(rel, {
      size,
      mtime: Math.floor(Number(record.slice(t1 + 1, t2))),
      mode: parseInt(record.slice(t2 + 1, t3), 8) & 0o7777,
    });
    const slash = rel.lastIndexOf('/');
    conn.noteDir(slash < 0 ? root : joinPosix(root, rel.slice(0, slash)));
  }
  return { files, skipped };
}

async function scanWithSftp(conn: Connection, root: string, ig: IgnoreRules, maxSize: number): Promise<ScanResult> {
  const files: FileMap = new Map();
  const skipped = new Set<string>();
  let level = [''];
  while (level.length) {
    const next: string[] = [];
    await mapLimit(level, 8, async (rel) => {
      const dir = rel ? joinPosix(root, rel) : root;
      let entries;
      try {
        entries = await conn.readdir(dir);
      } catch {
        return; // unreadable folder: leave it alone
      }
      conn.noteDir(dir);
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDir) {
          if (!ig.ignores(r, true)) next.push(r);
        } else if (e.isFile && !ig.ignores(r)) {
          if (maxSize > 0 && e.size > maxSize) skipped.add(r);
          else files.set(r, { size: e.size, mtime: e.mtime, mode: e.mode });
        }
      }
    });
    level = next;
  }
  return { files, skipped };
}
