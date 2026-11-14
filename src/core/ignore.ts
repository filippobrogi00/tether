import ignore, { Ignore } from 'ignore';
import * as fs from 'fs';
import * as path from 'path';

/** Temp files the engine itself creates while transferring. Always ignored. */
export const TEMP_PATTERNS = ['.*.tether-tmp', '.*.cl-tmp'];

export const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.mypy_cache/',
  '.pytest_cache/',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
];

export class IgnoreRules {
  private readonly ig: Ignore;
  /** Plain directory/file names that can be pruned server-side by `find`. */
  readonly pruneNames: string[];

  constructor(patterns: string[]) {
    const all = [...TEMP_PATTERNS, ...patterns];
    this.ig = ignore().add(all);
    this.pruneNames = all
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('#') && !p.startsWith('!'))
      .map((p) => p.replace(/\/$/, ''))
      .filter((p) => !p.includes('/') && !/[*?[\]\\]/.test(p));
  }

  /** `rel` is a POSIX relative path; pass `isDir` for directories. */
  ignores(rel: string, isDir = false): boolean {
    if (!rel) return false;
    return this.ig.ignores(isDir ? rel + '/' : rel);
  }

  /** True when the file itself or any directory above it is ignored. */
  ignoresPath(rel: string): boolean {
    const parts = rel.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? prefix + '/' + parts[i] : parts[i];
      if (this.ignores(prefix, true)) return true;
    }
    return this.ignores(rel);
  }

  /** Combine settings, optional `.tetherignore` / `.connectignore`, and optionally the root `.gitignore`. */
  static load(localRoot: string, patterns: string[], respectGitignore: boolean): IgnoreRules {
    const all = [...patterns];
    const read = (name: string) => {
      try {
        all.push(...fs.readFileSync(path.join(localRoot, name), 'utf8').split(/\r?\n/));
      } catch {
        /* file is optional */
      }
    };
    read('.tetherignore');
    read('.connectignore');
    if (respectGitignore) read('.gitignore');
    return new IgnoreRules(all);
  }
}
