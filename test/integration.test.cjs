// End-to-end tests of the sync engine against a real SSH server.
//
// Needs an SSH server you can log into without prompts, whose files are also
// visible on this machine (the simplest setup is sshd on localhost):
//
//   CL_TEST_TARGET=testbox CL_TEST_REMOTE_DIR=/tmp/cl-remote npm run test:integration
//
// CL_TEST_TARGET is an alias from ~/.ssh/config or user@host:port.
// Optional: CL_TEST_PASSWORD (password login), CL_TEST_JUMP_TARGET (alias that uses ProxyJump),
// CL_TEST_LOCKED_TARGET + CL_TEST_PASSPHRASE (alias whose key has a passphrase).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../out-test/core.js');

const TARGET = process.env.CL_TEST_TARGET;
if (!TARGET) {
  test('integration tests skipped (set CL_TEST_TARGET to run them)', { skip: true }, () => {});
  return;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
const LOCAL = path.join(work, 'local');
const REMOTE = process.env.CL_TEST_REMOTE_DIR || path.join(work, 'remote');
fs.rmSync(REMOTE, { recursive: true, force: true });
fs.mkdirSync(LOCAL, { recursive: true });
fs.mkdirSync(REMOTE, { recursive: true });

const asked = [];
const prompter = {
  password: async (t, attempt) => (asked.push('password'), attempt === 0 ? process.env.CL_TEST_PASSWORD : undefined),
  passphrase: async () => (asked.push('passphrase'), process.env.CL_TEST_PASSPHRASE),
  keyboardInteractive: async () => undefined,
  confirmHostKey: async () => (asked.push('hostkey'), true),
};
const log = { info() {}, warn: (m) => console.log('   warn:', m), error: (m) => console.log('   error:', m) };
const knownHosts = new core.KnownHosts(path.join(work, 'known.json'));
const deps = { prompter, log, knownHosts };

const w = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const r = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (root, rel) => fs.existsSync(path.join(root, rel));
const counts = (res) => [res.uploaded, res.downloaded, res.deletedLocal, res.deletedRemote, res.conflicts, res.errors.length];
// Remote mtimes have 1 s resolution; make sure "edited later" is visible even if the size stays equal.
const tick = () => new Promise((res) => setTimeout(res, 1100));

let conn;
let engine;
let deleteAnswer = true;
let deleteAsked = 0;

function makeEngine(connection, extra = {}) {
  return new core.SyncEngine(connection, {
    localRoot: LOCAL,
    remoteRoot: connection.resolvePath(REMOTE),
    manifestFile: path.join(work, 'manifest.json'),
    loadIgnore: () => core.IgnoreRules.load(LOCAL, core.DEFAULT_IGNORES, false),
    maxFileSize: 1024 * 1024,
    concurrency: 6,
    conflictPolicy: 'ask',
    confirmDeletesOver: 5,
    log,
    confirmDeletes: async () => (deleteAsked++, deleteAnswer),
    ...extra,
  });
}

test('connects using ~/.ssh/config, asks once about the unknown host key', async () => {
  conn = await core.Connection.open(TARGET, deps);
  assert.ok(conn.home.startsWith('/'));
  assert.deepStrictEqual(asked, ['hostkey']);
  const again = await core.Connection.open(TARGET, deps);
  assert.deepStrictEqual(asked, ['hostkey'], 'second connection must not ask again');
  again.close();
});

test('first sync merges both sides and flags the one real difference', async () => {
  w(LOCAL, 'a.txt', 'local a');
  w(LOCAL, 'src/main.c', 'int main(){}');
  w(LOCAL, 'run.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(LOCAL, 'run.sh'), 0o755);
  w(LOCAL, 'same.txt', 'identical');
  w(LOCAL, 'differs.txt', 'local-version');
  w(LOCAL, 'node_modules/pkg/index.js', 'ignored');
  w(LOCAL, 'weird name/ü ñ $x.txt', 'unicode and spaces');
  w(REMOTE, 'r.txt', 'remote r');
  w(REMOTE, 'deep/er/log.txt', 'remote log');
  w(REMOTE, 'same.txt', 'identical');
  w(REMOTE, 'differs.txt', 'REMOTE-VERSION');
  w(REMOTE, '.git/HEAD', 'ignored');

  engine = makeEngine(conn);
  await engine.init();
  const res = await engine.reconcile();
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(counts(res), [4, 2, 0, 0, 1, 0]);
  assert.strictEqual(r(REMOTE, 'a.txt'), 'local a');
  assert.strictEqual(r(REMOTE, 'weird name/ü ñ $x.txt'), 'unicode and spaces');
  assert.strictEqual(r(LOCAL, 'deep/er/log.txt'), 'remote log');
  assert.ok(!has(REMOTE, 'node_modules'), 'ignored folder must not be uploaded');
  assert.ok(!has(LOCAL, '.git'), 'ignored folder must not be downloaded');
  assert.strictEqual(fs.statSync(path.join(REMOTE, 'run.sh')).mode & 0o777, 0o755, 'executable bit preserved');
  assert.deepStrictEqual([...engine.conflicts.keys()], ['differs.txt']);
  assert.strictEqual(r(LOCAL, 'differs.txt'), 'local-version', 'conflicted file is left alone');
  assert.ok(fs.readdirSync(REMOTE).every((n) => !n.endsWith('.cl-tmp') && !n.endsWith('.tether-tmp')), 'no temp files left behind');
});

test('same-size files with different content are a conflict, not "in sync"', async () => {
  w(LOCAL, 'samesize.txt', 'AAAA');
  w(REMOTE, 'samesize.txt', 'BBBB');
  const res = await engine.reconcile();
  assert.strictEqual(res.conflicts, 2);
  assert.ok(engine.conflicts.has('samesize.txt'));
});

test('resolving conflicts: keep local, keep remote, keep both', async () => {
  await engine.resolveConflict('samesize.txt', 'remote');
  assert.strictEqual(r(LOCAL, 'samesize.txt'), 'BBBB');
  await engine.resolveConflict('differs.txt', 'both');
  assert.strictEqual(r(REMOTE, 'differs.txt'), 'local-version');
  assert.strictEqual(r(LOCAL, 'differs.server-copy.txt'), 'REMOTE-VERSION');
  const res = await engine.reconcile(); // the kept copy is a new local file and gets published
  assert.deepStrictEqual(counts(res), [1, 0, 0, 0, 0, 0]);
  assert.strictEqual(r(REMOTE, 'differs.server-copy.txt'), 'REMOTE-VERSION');
});

test('a second sync with no changes does nothing', async () => {
  assert.deepStrictEqual(counts(await engine.reconcile()), [0, 0, 0, 0, 0, 0]);
});

test('fast path: a local save is pushed, a new folder is pushed, our own downloads are not echoed', async () => {
  w(LOCAL, 'a.txt', 'local a, edited');
  w(LOCAL, 'newdir/x/y.txt', 'new tree');
  const res = await engine.pushPaths(['a.txt', 'newdir', 'deep/er/log.txt']);
  assert.deepStrictEqual(counts(res), [2, 0, 0, 0, 0, 0]);
  assert.strictEqual(r(REMOTE, 'a.txt'), 'local a, edited');
  assert.strictEqual(r(REMOTE, 'newdir/x/y.txt'), 'new tree');
});

test('fast path: deleting a local folder removes it remotely and prunes empty folders', async () => {
  fs.rmSync(path.join(LOCAL, 'newdir'), { recursive: true });
  const res = await engine.pushPaths(['newdir']);
  assert.deepStrictEqual(counts(res), [0, 0, 0, 1, 0, 0]);
  assert.ok(!has(REMOTE, 'newdir'));
});

test('fast path never overwrites a file that changed on the server meanwhile', async () => {
  await tick();
  w(REMOTE, 'a.txt', 'edited on the server by someone else');
  w(LOCAL, 'a.txt', 'edited locally at the same time');
  const res = await engine.pushPaths(['a.txt']);
  assert.deepStrictEqual(counts(res), [0, 0, 0, 0, 1, 0]);
  assert.strictEqual(r(REMOTE, 'a.txt'), 'edited on the server by someone else');
  await engine.resolveConflict('a.txt', 'local');
  assert.strictEqual(r(REMOTE, 'a.txt'), 'edited locally at the same time');
});

test('remote edits and remote deletions come back on the next sync', async () => {
  await tick();
  w(REMOTE, 'r.txt', 'remote r, edited on the server');
  fs.rmSync(path.join(REMOTE, 'deep'), { recursive: true });
  w(REMOTE, 'build/output.log', 'made by a build on the server');
  const res = await engine.reconcile();
  assert.deepStrictEqual(counts(res), [0, 2, 1, 0, 0, 0]);
  assert.strictEqual(r(LOCAL, 'r.txt'), 'remote r, edited on the server');
  assert.ok(!has(LOCAL, 'deep'), 'deleted remotely -> deleted locally, empty folders pruned');
  assert.strictEqual(r(LOCAL, 'build/output.log'), 'made by a build on the server');
});

test('hundreds of files in brand-new nested folders upload in parallel without errors', async () => {
  for (let i = 0; i < 300; i++) w(LOCAL, `bulk/d${i % 25}/s${i % 4}/f${i}.txt`, 'data ' + i);
  const res = await engine.reconcile();
  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(res.uploaded, 300);
  assert.strictEqual(r(REMOTE, 'bulk/d24/s3/f299.txt'), 'data 299');
  fs.rmSync(path.join(LOCAL, 'bulk'), { recursive: true });
  assert.strictEqual((await engine.pushPaths(['bulk'])).deletedRemote, 300);
  assert.ok(!has(REMOTE, 'bulk'));
});

test('oversized files are reported and left alone on both sides', async () => {
  w(LOCAL, 'big.bin', Buffer.alloc(2 * 1024 * 1024, 1));
  const res = await engine.reconcile();
  assert.deepStrictEqual(res.skippedLarge, ['big.bin']);
  assert.ok(!has(REMOTE, 'big.bin'));
  fs.rmSync(path.join(LOCAL, 'big.bin'));
});

test('mass deletion needs confirmation; declining deletes nothing', async () => {
  for (let i = 0; i < 8; i++) w(LOCAL, `many/f${i}.txt`, 'x' + i);
  assert.strictEqual((await engine.reconcile()).uploaded, 8);
  fs.rmSync(path.join(LOCAL, 'many'), { recursive: true });
  deleteAnswer = false;
  const askedBefore = deleteAsked;
  let res = await engine.reconcile();
  assert.strictEqual(deleteAsked, askedBefore + 1);
  assert.strictEqual(res.deletesDeclined, true);
  assert.strictEqual(fs.readdirSync(path.join(REMOTE, 'many')).length, 8);
  deleteAnswer = true;
  res = await engine.reconcile();
  assert.strictEqual(res.deletedRemote, 8);
  assert.ok(!has(REMOTE, 'many'));
});

test('a side that suddenly looks empty always asks before deleting, even below the threshold', async () => {
  w(LOCAL, 'few/one.txt', '1');
  await engine.reconcile();
  const stash = path.join(work, 'stash');
  fs.renameSync(LOCAL, stash); // e.g. the disk holding the project was unmounted
  await assert.rejects(engine.reconcile(), /no longer exists/);
  fs.mkdirSync(LOCAL); // ...or the folder is there but empty
  deleteAnswer = false;
  const asked = deleteAsked;
  const res = await engine.reconcile();
  assert.strictEqual(deleteAsked, asked + 1);
  assert.strictEqual(res.deletedRemote, 0);
  assert.strictEqual(r(REMOTE, 'few/one.txt'), '1');
  fs.rmSync(LOCAL, { recursive: true });
  fs.renameSync(stash, LOCAL);
  deleteAnswer = true;
  assert.deepStrictEqual(counts(await engine.reconcile()), [0, 0, 0, 0, 0, 0]);
});

test('state survives a restart; an interrupted run is recovered by hashing, not re-copied', async () => {
  const fresh = makeEngine(conn);
  await fresh.init();
  assert.deepStrictEqual(counts(await fresh.reconcile()), [0, 0, 0, 0, 0, 0]);

  fs.rmSync(path.join(work, 'manifest.json')); // simulate losing all sync state
  const lost = makeEngine(conn);
  await lost.init();
  const res = await lost.reconcile();
  assert.deepStrictEqual(counts(res), [0, 0, 0, 0, 0, 0], 'identical trees are adopted via server-side hashes');
  assert.ok(lost.trackedCount >= 8);
  engine = lost;
});

test('works without a shell-side `find` (SFTP-only listing fallback)', async () => {
  conn.caps.find = false;
  w(LOCAL, 'fallback.txt', 'via sftp listing');
  await tick();
  w(REMOTE, 'r.txt', 'changed again remotely');
  const res = await engine.reconcile();
  assert.deepStrictEqual(counts(res), [1, 1, 0, 0, 0, 0]);
  conn.caps.find = undefined;
});

test('conflict policy can settle conflicts automatically', async () => {
  const auto = makeEngine(conn, { conflictPolicy: 'preferRemote' });
  await auto.init();
  await tick();
  w(LOCAL, 'r.txt', 'local opinion');
  w(REMOTE, 'r.txt', 'the server wins this one');
  const res = await auto.reconcile();
  assert.deepStrictEqual(counts(res), [0, 1, 0, 0, 0, 0]);
  assert.strictEqual(r(LOCAL, 'r.txt'), 'the server wins this one');
  engine = auto;
});

test('remote commands, port forwarding and reconnecting with kept state', async () => {
  const out = await conn.exec('echo hello-from-server');
  assert.strictEqual(out.stdout.toString().trim(), 'hello-from-server');

  const stream = await conn.forward('127.0.0.1', conn.host.port); // tunnel to the SSH port itself
  const banner = await new Promise((res) => stream.once('data', (d) => res(d.toString())));
  assert.match(banner, /^SSH-2\.0/);
  stream.destroy();

  const closed = new Promise((res) => conn.once('close', res));
  conn.close();
  await closed;
  w(LOCAL, 'offline-edit.txt', 'written while disconnected');
  conn = await core.Connection.open(TARGET, deps);
  engine.setConnection(conn);
  const res = await engine.reconcile();
  assert.deepStrictEqual(counts(res), [1, 0, 0, 0, 0, 0]);
  assert.strictEqual(r(REMOTE, 'offline-edit.txt'), 'written while disconnected');
});

test('password login', { skip: !process.env.CL_TEST_PASSWORD }, async () => {
  asked.length = 0;
  const home = process.env.HOME;
  process.env.HOME = work; // no keys, no ssh config: forces the password path
  delete process.env.SSH_AUTH_SOCK;
  try {
    const c = await core.Connection.open(`${conn.host.user}@${conn.host.hostName}:${conn.host.port}`, deps);
    assert.ok(asked.includes('password'));
    c.close();
  } finally {
    process.env.HOME = home;
  }
});

test('wrong password gives a clear error', { skip: !process.env.CL_TEST_PASSWORD }, async () => {
  const home = process.env.HOME;
  process.env.HOME = work;
  try {
    const bad = { ...deps, prompter: { ...prompter, password: async (t, n) => (n === 0 ? 'definitely-wrong' : undefined) } };
    await assert.rejects(
      core.Connection.open(`${conn.host.user}@${conn.host.hostName}:${conn.host.port}`, bad),
      (err) => err instanceof core.UserCancelled || /sign in/i.test(err.message),
    );
  } finally {
    process.env.HOME = home;
  }
});

test('ProxyJump from ~/.ssh/config', { skip: !process.env.CL_TEST_JUMP_TARGET }, async () => {
  const c = await core.Connection.open(process.env.CL_TEST_JUMP_TARGET, deps);
  assert.strictEqual((await c.exec('echo through-jump')).stdout.toString().trim(), 'through-jump');
  c.close();
});

test('passphrase-protected key', { skip: !process.env.CL_TEST_LOCKED_TARGET }, async () => {
  asked.length = 0;
  const c = await core.Connection.open(process.env.CL_TEST_LOCKED_TARGET, deps);
  assert.ok(asked.includes('passphrase'));
  c.close();
});

test.after(() => {
  conn?.close();
  fs.rmSync(work, { recursive: true, force: true });
});
