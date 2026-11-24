// Unit tests for the pure three-way planner. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const { plan, IgnoreRules, KnownHosts, parseTarget, bootstrapDirection, BOOTSTRAP_MIN_FILES } = require('../out-test/core.js');

const st = (size, mtime) => ({ size, mtime });
const m = (obj) => new Map(Object.entries(obj));
const kinds = (actions) => Object.fromEntries(actions.map((a) => [a.path, a.kind + (a.reason ? ':' + a.reason : '')]));

test('first sync: each side contributes what the other lacks', () => {
  const actions = plan({
    local: m({ a: st(1, 10), same: st(5, 10), diff: st(5, 10) }),
    remote: m({ b: st(2, 20), same: st(5, 99), diff: st(7, 99) }),
    base: new Map(),
  });
  assert.deepStrictEqual(kinds(actions), { a: 'upload', b: 'download', same: 'verify', diff: 'conflict:both-new' });
});

test('changes are judged against the manifest, never against the other side', () => {
  const base = m({
    edited_here: { l: st(1, 10), r: st(1, 500) },
    edited_there: { l: st(1, 10), r: st(1, 500) },
    untouched: { l: st(1, 10), r: st(1, 500) },
    both: { l: st(1, 10), r: st(1, 500) },
  });
  const actions = plan({
    local: m({ edited_here: st(2, 11), edited_there: st(1, 10), untouched: st(1, 10), both: st(3, 12) }),
    remote: m({ edited_here: st(1, 500), edited_there: st(4, 600), untouched: st(1, 500), both: st(9, 700) }),
    base,
  });
  assert.deepStrictEqual(kinds(actions), {
    edited_here: 'upload',
    edited_there: 'download',
    both: 'conflict:both-changed',
  });
});

test('deletions propagate only for files that were synced before', () => {
  const base = m({
    gone_here: { l: st(1, 10), r: st(1, 500) },
    gone_there: { l: st(1, 10), r: st(1, 500) },
    gone_both: { l: st(1, 10), r: st(1, 500) },
    del_vs_edit: { l: st(1, 10), r: st(1, 500) },
    edit_vs_del: { l: st(1, 10), r: st(1, 500) },
  });
  const actions = plan({
    local: m({ gone_there: st(1, 10), edit_vs_del: st(8, 99) }),
    remote: m({ gone_here: st(1, 500), del_vs_edit: st(8, 900) }),
    base,
  });
  assert.deepStrictEqual(kinds(actions), {
    gone_here: 'deleteRemote',
    gone_there: 'deleteLocal',
    gone_both: 'forget',
    del_vs_edit: 'conflict:local-deleted-remote-changed',
    edit_vs_del: 'conflict:remote-deleted-local-changed',
  });
});

test('newly ignored and oversized files are never treated as deletions', () => {
  const base = m({ 'build/out.bin': { l: st(1, 10), r: st(1, 500) }, 'big.iso': { l: st(1, 10), r: st(1, 500) } });
  const ig = new IgnoreRules(['build/']);
  const actions = plan({
    local: new Map(),
    remote: new Map(),
    base,
    skipped: new Set(['big.iso']),
    isIgnored: (p) => ig.ignoresPath(p),
  });
  assert.deepStrictEqual(kinds(actions), { 'build/out.bin': 'forget' });
});

test('.git is never synced, even if a rule tries to include it', () => {
  const ig = new IgnoreRules([]);
  assert.ok(ig.ignoresPath('.git/HEAD'));
  assert.ok(ig.ignoresPath('.git/FETCH_HEAD'));
  assert.ok(ig.ignoresPath('.git/config'));
  assert.ok(ig.ignoresPath('.git/index.lock'));
  assert.ok(!ig.ignoresPath('src/main.c'));
  assert.ok(!ig.ignoresPath('Cargo.lock'));
  const negated = new IgnoreRules(['!.git/', '!.git/**', '!.git/HEAD']);
  assert.ok(negated.ignoresPath('.git/HEAD'));
  assert.ok(negated.ignoresPath('.git/FETCH_HEAD'));
  assert.ok(negated.ignoresPath('.git/config'));
});

test('ignore rules: defaults-style patterns, nesting, and server-side prune names', () => {
  const ig = new IgnoreRules(['node_modules/', '*.pyc', '/dist', 'logs/*.log']);
  assert.ok(ig.ignoresPath('node_modules/x/index.js'));
  assert.ok(ig.ignoresPath('pkg/node_modules/y.js'));
  assert.ok(ig.ignoresPath('a/b.pyc'));
  assert.ok(ig.ignoresPath('.main.c.1a2b3c4d.cl-tmp'));
  assert.ok(ig.ignoresPath('.main.c.1a2b3c4d.tether-tmp'));
  assert.ok(!ig.ignoresPath('src/main.c'));
  assert.deepStrictEqual(ig.pruneNames, ['node_modules', '.git']);
});

test('host keys: unknown, trusted after accept, and a changed key is flagged', () => {
  const key = (name) => {
    const t = Buffer.from('ssh-ed25519');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(t.length);
    return Buffer.concat([len, t, Buffer.from(name)]);
  };
  const kh = new KnownHosts();
  assert.strictEqual(kh.check('never-seen.invalid', 22, key('one')), 'unknown');
  kh.trust('never-seen.invalid', 22, key('one'));
  assert.strictEqual(kh.check('never-seen.invalid', 22, key('one')), 'trusted');
  assert.strictEqual(kh.check('never-seen.invalid', 22, key('two')), 'changed');
  assert.match(KnownHosts.fingerprint(key('one')), /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('target parsing', () => {
  assert.deepStrictEqual(parseTarget('me@box.example:2200'), { user: 'me', host: 'box.example', port: 2200 });
  assert.deepStrictEqual(parseTarget('box'), { user: undefined, host: 'box', port: undefined });
  assert.deepStrictEqual(parseTarget('me@[::1]:22'), { user: 'me', host: '::1', port: 22 });
});

test('archive bootstrap: chosen for large one-sided cold syncs only', () => {
  const manyUploads = Array.from({ length: BOOTSTRAP_MIN_FILES }, (_, i) => ({ kind: 'upload', path: `f${i}` }));
  assert.strictEqual(bootstrapDirection(manyUploads), 'upload');
  const manyDownloads = Array.from({ length: BOOTSTRAP_MIN_FILES }, (_, i) => ({ kind: 'download', path: `f${i}` }));
  assert.strictEqual(bootstrapDirection(manyDownloads), 'download');
  assert.strictEqual(bootstrapDirection(manyUploads.slice(0, 5)), undefined);
  assert.strictEqual(bootstrapDirection([...manyUploads, { kind: 'download', path: 'x' }]), undefined);
  assert.strictEqual(bootstrapDirection([...manyUploads, { kind: 'conflict', path: 'c', reason: 'both-new' }]), undefined);
});
