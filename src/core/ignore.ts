import ignore, { Ignore } from 'ignore';
import * as fs from 'fs';
import * as path from 'path';

/** Temp files the engine itself creates while transferring. Always ignored. */
export const TEMP_PATTERNS = ['.*.tether-tmp', '.*.cl-tmp'];

/**
 * Scratch files Git rewrites on fetch, merge, and rebase. Always ignored, even
 * when `.git/` itself is synced: `FETCH_HEAD` in particular changes on every
 * autofetch and would otherwise keep a sync in flight forever.
 * Lock files are skipped because copying one mid-update can wedge the transfer.
 */
const VOLATILE_GIT_FILES = [
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'BISECT_LOG',
  'AUTO_MERGE',
  'COMMIT_EDITMSG',
];

export const VOLATILE_GIT_PATTERNS = [
  ...VOLATILE_GIT_FILES.flatMap((name) => [`.git/${name}`, `.git/**/${name}`]),
  '.git/*.lock',
  '.git/**/*.lock',
  '.git/sequencer/',
  '.git/**/sequencer/',
];

/**
 * Directories and files that are never synced unless Connect Folder checks them
 * back on (top-level only) or the pattern is removed from `tether.ignore`.
 *
 * Directory patterns apply at any depth. `/bin/`, `/debug/`, `/release/`,
 * `/temp/`, `/Library/`, and `/Saved/` (and their other capitalizations) are
 * anchored to the project root so nested source trees with those names still
 * sync. The matcher is case-insensitive, so `src/debug` must not use a global
 * `Debug/` rule. SDK-style .NET output is covered by `obj/` and `bin/Debug`.
 *
 * Keep this list identical to the `tether.ignore` default in `package.json`.
 */
export const DEFAULT_IGNORES = [
  // Dependencies and environments.
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  'web_modules/',
  'Pods/',
  'deps/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '__pypackages__/',
  '.eggs/',
  '*.egg-info/',
  '.tox/',
  '.nox/',
  '.hypothesis/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.pytype/',
  '.phpunit.cache/',
  '.ipynb_checkpoints/',
  'htmlcov/',
  '.pdm-build/',
  'pip-wheel-metadata/',
  '**/vendor/bundle/',
  '**/.yarn/cache/',
  '**/.yarn/unplugged/',

  // Build output, at any depth. Short names such as `build` and `debug` are
  // included because they are the usual compiler output; a top-level one can
  // be checked back on in Connect Folder.
  'build/',
  'Build/',
  'builds/',
  'Builds/',
  'target/',
  'dist/',
  'dist-ssr/',
  'dist-types/',
  'dist-cjs/',
  'dist-esm/',
  'dist-es/',
  'dist-newstyle/',
  'out/',
  'output/',
  '_build/',
  '.build/',
  'cmake-build-debug/',
  'cmake-build-release/',
  'cmake-build-relwithdebinfo/',
  'cmake-build-minsizerel/',
  'cmake-build-*/',
  'CMakeFiles/',
  'CMakeScripts/',
  'obj/',
  'Obj/',
  '**/bin/Debug/',
  '**/bin/Release/',
  '**/bin/RelWithDebInfo/',
  '**/bin/MinSizeRel/',
  'x64/',
  'x86/',
  'Win32/',
  'ARM64/',
  'artifacts/',
  'BenchmarkDotNet.Artifacts/',
  'publish/',
  'generated/',
  'generated-sources/',
  'generated-test-sources/',
  'coverage/',
  '.nyc_output/',
  'TestResults/',
  'test-results/',
  'test-output/',
  'lib-cov/',
  'staticfiles/',
  '_site/',
  '_book/',
  'storybook-static/',
  'zig-out/',
  'DerivedData/',
  'DerivedDataCache/',
  'Intermediate/',
  'Binaries/',
  'MemoryCaptures/',
  'tmp/',
  '.tmp/',
  '.temp/',

  // Tool and compiler caches.
  '.cache/',
  '.gradle/',
  '.kotlin/',
  '.metals/',
  '.bloop/',
  '.bsp/',
  '.cpcache/',
  '.shadow-cljs/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.svelte-kit/',
  '.angular/',
  '.turbo/',
  '.nx/',
  '.parcel-cache/',
  '.webpack/',
  '.vite/',
  '.swc/',
  '.docusaurus/',
  '.astro/',
  '.expo/',
  '.serverless/',
  '.fusebox/',
  '.rollup.cache/',
  '.dart_tool/',
  '.swiftpm/',
  '.stack-work/',
  '.cabal-sandbox/',
  'elm-stuff/',
  '.spago/',
  'zig-cache/',
  '.zig-cache/',
  'nimcache/',
  '.nimcache/',
  '.godot/',
  '.import/',
  'bazel-bin/',
  'bazel-out/',
  'bazel-testlogs/',
  'bazel-genfiles/',
  'buck-out/',
  '.pants.d/',
  'plz-out/',
  '.terraform/',
  '.terragrunt-cache/',
  'packer_cache/',
  '.vs/',
  '.cxx/',
  '.externalNativeBuild/',
  '.deps/',
  '.libs/',
  'autom4te.cache/',
  'meson-private/',
  'meson-info/',
  'meson-logs/',
  '.jekyll-cache/',
  '.sass-cache/',
  '.lake/',
  '.dub/',
  'cover_db/',
  'blib/',
  'slprj/',
  'sccprj/',
  'codegen/',
  '.Rproj.user/',
  'xcuserdata/',
  '.direnv/',
  '.bundle/',
  '**/storage/framework/cache/',
  '**/storage/framework/sessions/',
  '**/storage/framework/views/',
  '**/bootstrap/cache/',
  '**/var/cache/',
  '**/.vitepress/cache/',
  '**/.vitepress/dist/',
  '**/.vuepress/.cache/',
  '**/.vuepress/.temp/',
  '**/.vuepress/dist/',
  '**/resources/_gen/',
  '**/.meteor/local/',
  '**/Carthage/Build/',
  '**/lib/bs/',

  // Root-only. Both spellings are listed so `find -path` can prune either
  // case on a case-sensitive server. Nested `src/bin` and `src/debug` still sync.
  '/bin/',
  '/Bin/',
  '/debug/',
  '/Debug/',
  '/release/',
  '/Release/',
  '/temp/',
  '/Temp/',
  '/Library/',
  '/library/',
  '/Saved/',
  '/saved/',

  // Regenerable compiler debris and OS junk. Not shipped binaries.
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.lo',
  '*.beam',
  '*.tsbuildinfo',
  '.DS_Store',
  'Thumbs.db',
  'Desktop.ini',
  '.eslintcache',
  '.stylelintcache',
  'CMakeCache.txt',
  '.flutter-plugins',
  '.flutter-plugins-dependencies',
];

/** Top-level names chosen in Connect Folder. */
export interface RootSyncFilter {
  /** Unchecked names. Anchored to the project root, so a nested folder with the same name can still sync. */
  exclude?: readonly string[];
  /**
   * Checked names that an ignore rule would otherwise skip.
   * The folder is synced in full, except `.git/` and transfer temp files.
   */
  include?: readonly string[];
}

export interface LocalEntry {
  name: string;
  isDir: boolean;
}

export interface RootSyncSelection {
  exclude: string[];
  include: string[];
}

export class IgnoreRules {
  private readonly ig: Ignore;
  /** Rules for a top-level folder the user explicitly checked back on. */
  private readonly optedIn: Ignore;
  private readonly rootExclude: Set<string>;
  private readonly rootInclude: Set<string>;
  /** Plain directory/file names that can be pruned server-side by `find -name`. */
  readonly pruneNames: string[];
  /** Project-root directory names pruned with `find -path ./name` (not nested matches). */
  readonly pruneRoots: string[];

  constructor(patterns: string[], root?: RootSyncFilter) {
    const include = new Set((root?.include ?? []).filter(isRootName));
    const exclude = new Set((root?.exclude ?? []).filter(isRootName));
    for (const name of exclude) include.delete(name);
    this.rootInclude = include;
    this.rootExclude = exclude;

    // Always-on patterns come last so a user negation cannot opt back into them.
    // `.git/` is never synced: the remote repo is created with `git init` instead.
    const always = [...TEMP_PATTERNS, ...VOLATILE_GIT_PATTERNS, '.git/'];
    const all = [...patterns, ...always];
    this.ig = ignore().add(all);
    this.optedIn = ignore().add(always);

    const dirNames: string[] = [];
    const rootDirs: string[] = [];
    for (const line of all) {
      const dir = literalPruneName(line);
      if (dir) dirNames.push(dir);
      const anchored = anchoredRootDir(line);
      if (anchored) rootDirs.push(anchored);
    }
    for (const name of exclude) rootDirs.push(name);
    this.pruneNames = unique(dirNames).filter((n) => !include.has(n));
    const pruned = new Set(this.pruneNames);
    this.pruneRoots = unique(rootDirs).filter((n) => n !== '.git' && !include.has(n) && !pruned.has(n));
  }

  /** `rel` is a POSIX relative path; pass `isDir` for directories. */
  ignores(rel: string, isDir = false): boolean {
    if (!rel) return false;
    if (rel === '.git' || rel.startsWith('.git/')) return true;
    const slash = rel.indexOf('/');
    const top = slash < 0 ? rel : rel.slice(0, slash);
    if (this.rootExclude.has(top)) return true;
    if (this.rootInclude.has(top)) {
      if (slash < 0) return false;
      const inner = rel.slice(slash + 1);
      return this.optedIn.ignores(isDir ? `${inner}/` : inner);
    }
    return this.ig.ignores(isDir ? `${rel}/` : rel);
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
  static load(localRoot: string, patterns: string[], respectGitignore: boolean, root?: RootSyncFilter): IgnoreRules {
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
    return new IgnoreRules(all, root);
  }
}

/** True when Connect Folder should start with this top-level entry checked. */
export function entryWillSync(name: string, isDir: boolean, rules: IgnoreRules): boolean {
  if (isDir && name === '.git') return false;
  return !rules.ignores(name, isDir);
}

/** Names that start checked, honoring a previous Connect Folder choice when there is one. */
export function initialSyncPicks(entries: readonly LocalEntry[], baseline: IgnoreRules, previous?: RootSyncFilter): string[] {
  const exclude = new Set(previous?.exclude ?? []);
  const include = new Set(previous?.include ?? []);
  const picked: string[] = [];
  for (const entry of entries) {
    if (entry.isDir && entry.name === '.git') continue;
    if (exclude.has(entry.name)) continue;
    if (include.has(entry.name) || entryWillSync(entry.name, entry.isDir, baseline)) picked.push(entry.name);
  }
  return picked;
}

/**
 * Turn the checkbox result into root filters.
 * Unchecked names are excluded. Checked names that the baseline would skip are included.
 * `.git` is dropped: the engine never syncs it.
 */
export function selectionFromPicks(
  entries: readonly LocalEntry[],
  picked: Iterable<string>,
  baseline: IgnoreRules,
): RootSyncSelection {
  const on = new Set(picked);
  const exclude: string[] = [];
  const include: string[] = [];
  for (const entry of entries) {
    if (!isRootName(entry.name)) continue;
    if (entry.isDir && entry.name === '.git') continue;
    if (!on.has(entry.name)) exclude.push(entry.name);
    else if (!entryWillSync(entry.name, entry.isDir, baseline)) include.push(entry.name);
  }
  exclude.sort();
  include.sort();
  return { exclude, include };
}

function isRootName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && name !== '.git' && !/[/\\\0]/.test(name);
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/** `node_modules/` → `node_modules`. Globs and paths stay out; `find -name` cannot express them. */
function literalPruneName(line: string): string | undefined {
  const raw = line.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('!') || raw.startsWith('/')) return undefined;
  const body = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (!body || body.includes('/') || /[*?[\]\\]/.test(body)) return undefined;
  return body;
}

/** `/bin/` or `/bin/**` → `bin`, for a root-only `find -path`. */
function anchoredRootDir(line: string): string | undefined {
  const raw = line.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('!') || !raw.startsWith('/')) return undefined;
  let body = raw.slice(1);
  if (body.endsWith('/**')) body = body.slice(0, -3);
  else if (body.endsWith('/')) body = body.slice(0, -1);
  if (!body || body.includes('/') || /[*?[\]\\]/.test(body)) return undefined;
  return body;
}
