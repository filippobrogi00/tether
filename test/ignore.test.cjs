// Default ignore rules and the Connect Folder checkbox selection. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_IGNORES,
  IgnoreRules,
  entryWillSync,
  findPruneExpr,
  initialSyncPicks,
  selectionFromPicks,
} = require('../out-test/core.js');

const defaults = () => new IgnoreRules(DEFAULT_IGNORES);

test('package.json ignore default matches DEFAULT_IGNORES', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.contributes.configuration.properties['tether.ignore'].default, DEFAULT_IGNORES);
});

test('build output and caches are skipped; source trees are not', () => {
  const ig = defaults();
  const skipped = [
    'target/release/app',
    'crates/foo/target/debug/app',
    'build/out.js',
    'pkg/dist/index.js',
    'out/main.js',
    'node_modules/leftpad/index.js',
    'src/__pycache__/a.pyc',
    '.venv/bin/python',
    '.next/server/app.js',
    '.gradle/caches/x',
    'src/App/bin/Debug/net8.0/App.dll',
    'src/App/obj/Debug/net8.0/App.dll',
    'bin/tool',
    'debug/app',
    'Library/cache.db',
    'temp/scratch',
    'coverage/lcov.info',
    'vendor/bundle/ruby/gem.rb',
    'apps/web/vendor/bundle/ruby/gem.rb',
    'Foo.class',
    'a.o',
    'mod.pyc',
    '.DS_Store',
  ];
  for (const rel of skipped) assert.ok(ig.ignoresPath(rel), rel);

  const kept = [
    'src/main.c',
    'src/bin/main.rs',
    'src/bin/util/main.rs',
    'src/debug/log.rs',
    'src/temp/notes.txt',
    'src/library/util.ts',
    'src/App/bin/App.exe',
    'Cargo.toml',
    'Cargo.lock',
    '.env',
    'public/index.html',
    'vendor/lib.php',
    'lib/app.js',
    'Foo.java',
    'README.md',
  ];
  for (const rel of kept) assert.ok(!ig.ignoresPath(rel), rel);
});

test('.git is never synced, even when a connect choice tries to include it', () => {
  const ig = new IgnoreRules(DEFAULT_IGNORES, { include: ['.git', 'target'] });
  assert.ok(ig.ignoresPath('.git/HEAD'));
  assert.ok(ig.ignoresPath('.git/config'));
  assert.ok(!ig.ignoresPath('target/debug/app'));
  assert.ok(ig.ignoresPath('target/.git/HEAD'));
  assert.ok(ig.ignoresPath('target/.main.rs.abc.tether-tmp'));
  assert.ok(ig.ignoresPath('pkg/target/debug/app'));
});

test('a checked top-level folder syncs its contents; an unchecked one stays local', () => {
  const ig = new IgnoreRules(DEFAULT_IGNORES, { include: ['target'], exclude: ['custom-out', 'notes.log'] });
  assert.ok(!ig.ignoresPath('target/release/app'));
  assert.ok(!ig.ignores('target', true));
  assert.ok(ig.ignoresPath('custom-out/a.bin'));
  assert.ok(ig.ignores('custom-out', true));
  assert.ok(!ig.ignoresPath('pkg/custom-out/a.bin'));
  assert.ok(ig.ignoresPath('notes.log'));
  assert.ok(!ig.ignoresPath('src/notes.log'));
  assert.ok(ig.ignoresPath('node_modules/x.js'));
});

test('server-side prune skips build dirs by name and root-only dirs by path', () => {
  const ig = defaults();
  assert.ok(ig.pruneNames.includes('target'));
  assert.ok(ig.pruneNames.includes('build'));
  assert.ok(ig.pruneNames.includes('node_modules'));
  assert.ok(ig.pruneNames.includes('.git'));
  assert.ok(!ig.pruneNames.includes('bin'));
  assert.ok(!ig.pruneNames.includes('debug'));
  assert.deepStrictEqual(ig.pruneRoots.filter((n) => ['bin', 'Bin', 'debug', 'release'].includes(n)).sort(), [
    'Bin',
    'bin',
    'debug',
    'release',
  ]);
  const expr = findPruneExpr(ig);
  assert.ok(expr.includes("-name 'target'"));
  assert.ok(expr.includes("-path './bin'"));
  assert.ok(!expr.includes("-name 'bin'"));

  const opted = new IgnoreRules(DEFAULT_IGNORES, { include: ['target'], exclude: ['custom-out'] });
  assert.ok(!opted.pruneNames.includes('target'));
  assert.ok(opted.pruneRoots.includes('custom-out'));
  const optedExpr = findPruneExpr(opted);
  assert.ok(!optedExpr.includes("-name 'target'"));
  assert.ok(optedExpr.includes("-path './custom-out'"));
});

test('connect checkboxes start from the ignore rules and remember a previous choice', () => {
  const ig = defaults();
  const entries = [
    { name: 'src', isDir: true },
    { name: 'target', isDir: true },
    { name: '.git', isDir: true },
    { name: 'README.md', isDir: false },
    { name: 'app.pyc', isDir: false },
    { name: 'custom-out', isDir: true },
  ];
  assert.strictEqual(entryWillSync('src', true, ig), true);
  assert.strictEqual(entryWillSync('target', true, ig), false);
  assert.strictEqual(entryWillSync('.git', true, ig), false);
  assert.strictEqual(entryWillSync('README.md', false, ig), true);
  assert.strictEqual(entryWillSync('app.pyc', false, ig), false);

  assert.deepStrictEqual(initialSyncPicks(entries, ig), ['src', 'README.md', 'custom-out']);
  assert.deepStrictEqual(initialSyncPicks(entries, ig, { exclude: ['src'], include: ['target'] }), [
    'target',
    'README.md',
    'custom-out',
  ]);

  const accepted = selectionFromPicks(entries, ['src', 'README.md', 'target', '.git'], ig);
  assert.deepStrictEqual(accepted, { exclude: ['app.pyc', 'custom-out'], include: ['target'] });

  const defaultsKept = selectionFromPicks(entries, initialSyncPicks(entries, ig), ig);
  assert.deepStrictEqual(defaultsKept, { exclude: ['app.pyc', 'target'], include: [] });
});
