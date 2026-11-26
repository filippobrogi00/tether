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
  const dirs = [prefix];
  const fileRels: string[] = [];
  let next = 0;
  let inFlight = 0;

  // Directories are listed concurrently. A recursive walk one folder at a time
  // turns "many directories" into a long chain of readdir calls.
  await new Promise<void>((resolve) => {
    const launch = (): void => {
      while (inFlight < 32 && next < dirs.length) {
        const rel = dirs[next++];
        inFlight++;
        void (async () => {
          try {
            const entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
            for (const e of entries) {
              const r = rel ? `${rel}/${e.name}` : e.name;
              // Symlinks are intentionally not followed or copied in this version.
              if (e.isDirectory()) {
                if (!ig.ignores(r, true)) dirs.push(r);
              } else if (e.isFile() && !ig.ignores(r)) fileRels.push(r);
            }
          } catch {
            // unreadable or vanished folder
          } finally {
            inFlight--;
            if (inFlight === 0 && next >= dirs.length) resolve();
            else launch();
          }
        })();
      }
      if (inFlight === 0 && next >= dirs.length) resolve();
    };
    launch();
  });

  await mapLimit(fileRels, 64, async (r) => {
    const st = await statLocal(path.join(root, r));
    if (!st) return;
    if (maxSize > 0 && st.size > maxSize) skipped.add(r);
    else files.set(r, st);
  });
  return { files, skipped };
}

// ---- remote ----------------------------------------------------------------

/**
 * List every file under `root` on the server.
 *
 * Fast path: one shell command, so a large tree is a single round trip.
 * GNU find `-printf` is tried first; busybox/GNU `stat` and BSD `stat` cover
 * the rest. Fallback: walk the tree over SFTP (SFTP-only accounts, or no `find`).
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

export type RemoteListStyle = 'printf' | 'gnu-stat' | 'bsd-stat';

async function scanWithFind(conn: Connection, root: string, ig: IgnoreRules, maxSize: number): Promise<ScanResult | undefined> {
  const styles: RemoteListStyle[] = conn.caps.findStyle ? [conn.caps.findStyle] : ['printf', 'gnu-stat', 'bsd-stat'];
  for (const style of styles) {
    const { code, stdout } = await conn.exec(remoteListCommand(root, ig, style));
    // Exit 0 with an empty tree is a real answer. A rejected flag (BSD find vs
    // `-printf`) is non-zero and usually prints nothing; try the next style.
    if (code !== 0) continue;
    conn.caps.findStyle = style;
    return parseRemoteListing(stdout, style, root, ig, maxSize, (dir) => conn.noteDir(dir));
  }
  return undefined;
}

function remoteListCommand(root: string, ig: IgnoreRules, style: RemoteListStyle): string {
  const prune = findPruneExpr(ig);
  const find = `cd -- ${shellQuote(root)} && find . ${prune}-type f`;
  if (style === 'printf') return `${find} -printf '%s\\t%T@\\t%m\\t%P\\0'`;
  // Real tab characters: BSD stat does not treat `\t` as an escape. GNU stat does,
  // and it also copies a literal tab through, so one format works for both.
  const fmt = style === 'gnu-stat' ? '%s\t%Y\t%a\t%n' : '%z\t%m\t%OLp\t%N';
  const flag = style === 'gnu-stat' ? '-c' : '-f';
  return `${find} -exec stat ${flag} ${shellQuote(fmt)} {} +`;
}

/** Parse one remote listing. `printf` records are NUL-separated; `stat` records are lines. */
export function parseRemoteListing(
  stdout: Buffer,
  style: RemoteListStyle,
  root: string,
  ig: IgnoreRules,
  maxSize: number,
  noteDir: (absDir: string) => void,
): ScanResult {
  const files: FileMap = new Map();
  const skipped = new Set<string>();
  const sep = style === 'printf' ? 0 : 10;
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf(sep, start);
    if (end < 0) end = stdout.length;
    const record = stdout.toString('utf8', start, end);
    start = end + 1;
    if (!record || record === '\r') continue;
    const t1 = record.indexOf('\t');
    const t2 = t1 < 0 ? -1 : record.indexOf('\t', t1 + 1);
    const t3 = t2 < 0 ? -1 : record.indexOf('\t', t2 + 1);
    if (t1 < 0 || t2 < 0 || t3 < 0) continue;
    let rel = record.slice(t3 + 1).replace(/\r$/, '');
    if (style !== 'printf' && rel.startsWith('./')) rel = rel.slice(2);
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
    noteDir(slash < 0 ? root : joinPosix(root, rel.slice(0, slash)));
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
