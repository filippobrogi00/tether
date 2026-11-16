// Drives the bundled extension through its real command handlers against a real
// SSH server, with the `vscode` module replaced by test/fake-vscode.cjs.
//
//   CL_TEST_TARGET=testbox npm run test:smoke
//
// The target must be an alias in ~/.ssh/config that logs in with a key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const Module = require('node:module');
const { execSync } = require('node:child_process');
const { vscode, fake, makeContext, Uri } = require('./fake-vscode.cjs');

const TARGET = process.env.CL_TEST_TARGET;
if (!TARGET) {
  test('smoke test skipped (set CL_TEST_TARGET to run it)', { skip: true }, () => {});
  return;
}

const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? vscode : load(request, ...rest));
const extension = require(process.env.CL_EXTENSION_JS || '../dist/extension.js');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-smoke-'));
const LOCAL = path.join(work, 'local');
const REMOTE = path.join(work, 'remote');
fs.mkdirSync(LOCAL);
fs.mkdirSync(REMOTE);
const context = makeContext(path.join(work, 'storage'));
fake.config.pollIntervalSeconds = 0;

const w = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const r = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const run = (id) => vscode.commands.executeCommand(id);
const status = () => fake.statusBar.text;
const until = async (what, cond, ms = 15000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for: ${what} (status "${status()}")\n${fake.log.slice(-8).join('\n')}`);
    await new Promise((res) => setTimeout(res, 50));
  }
};
const touch = (rel) => fake.watchers[0].change.fire(Uri.file(path.join(LOCAL, rel)));
const pickBy = (text) => (items) => items.find((i) => i.label.includes(text));

test('activates idle with a plain status bar item', async () => {
  fake.folders = [{ uri: Uri.file(LOCAL), name: 'local', index: 0 }];
  await extension.activate(context);
  assert.match(status(), /Tether/);
  assert.ok(fake.registered.has('tether.connectFolder'));
  assert.ok(fake.registered.has('tether.toggleSync'));
  assert.ok(fake.registered.has('tether.remoteView'));
  assert.ok(fake.registered.has('tether.upload'));
  assert.ok(fake.registered.has('tether.download'));
  assert.ok(fake.registered.has('tether.relay'));
});

test('wizard: pick host from ssh config, trust host key, type remote path, confirm merge, first sync', async () => {
  w(LOCAL, 'mine.txt', 'from laptop');
  w(REMOTE, 'theirs.txt', 'from server');
  const titles = [];
  fake.onQuickPick = (items, o) => {
    titles.push(o.title);
    if (/choose a server/.test(o.title)) return items.find((i) => i.value === TARGET);
    if (/choose the folder/.test(o.title)) return items.find((i) => i.action === 'type');
  };
  fake.onInput = (o) => (o.title === 'Folder on the server' ? REMOTE : undefined);
  fake.onMessage = (kind, text, o, buttons) => buttons.find((b) => /Trust and Connect|Merge and Connect/.test(b));

  await run('tether.connectFolder');
  await until('first sync', () => /in sync/.test(status()));
  assert.strictEqual(titles.length, 2, 'two wizard steps');
  assert.ok(fake.messages.some((m) => /First time connecting/.test(m.text)), 'host key was shown');
  assert.ok(fake.messages.some((m) => /Both folders already contain files/.test(m.text)), 'merge was explained');
  assert.strictEqual(r(REMOTE, 'mine.txt'), 'from laptop');
  assert.strictEqual(r(LOCAL, 'theirs.txt'), 'from server');
});

test('a local change is pushed by the file watcher without any command', async () => {
  w(LOCAL, 'src/app.py', 'print("v1")');
  fake.watchers[0].create.fire(Uri.file(path.join(LOCAL, 'src')));
  await until('upload', () => fs.existsSync(path.join(REMOTE, 'src/app.py')));
  assert.match(status(), /in sync|syncing/);
});

test('Sync Now pulls a change made on the server', async () => {
  await new Promise((res) => setTimeout(res, 1100));
  w(REMOTE, 'theirs.txt', 'from server, edited there');
  await run('tether.syncNow');
  await until('download', () => r(LOCAL, 'theirs.txt') === 'from server, edited there');
});

test('terminal runs on the server inside the synced folder', async () => {
  await run('tether.openTerminal');
  const term = fake.terminals[0];
  await until('shell', () => term.output.length > 0);
  term.pty.handleInput('echo "cwd=$(pwd) sum=$((40+2))"\r');
  await until('command output', () => term.output.includes('sum=42'));
  assert.ok(term.output.includes(`cwd=${fs.realpathSync(REMOTE)}`) || term.output.includes(`cwd=${REMOTE}`));
  term.pty.handleInput('exit\r');
  await until('terminal closed', () => term.closed);
});

test('port forwarding exposes a server port on localhost', async () => {
  const port = String(require('../out-test/core.js').resolveHost(TARGET).port);
  fake.onInput = () => port;
  fake.onMessage = () => undefined;
  await run('tether.forwardPort');
  const note = fake.messages.at(-1).text;
  const local = Number(/localhost:(\d+)/.exec(note)[1]);
  const banner = await new Promise((res, rej) => {
    const s = net.connect(local, '127.0.0.1');
    s.once('data', (d) => (s.destroy(), res(d.toString())));
    s.once('error', rej);
  });
  assert.match(banner, /^SSH-2\.0/);
});

test('conflict: shown in the status bar, resolved from the menu', async () => {
  await new Promise((res) => setTimeout(res, 1100));
  w(LOCAL, 'mine.txt', 'laptop wins');
  w(REMOTE, 'mine.txt', 'server also edited this');
  fake.onMessage = () => undefined;
  await run('tether.syncNow');
  await until('conflict state', () => /1 to review/.test(status()));
  assert.ok(fake.messages.some((m) => /changed both here and on the server/.test(m.text)));
  fake.onQuickPick = pickBy('Keep my version');
  await run('tether.resolveConflicts');
  await until('resolved', () => /in sync/.test(status()));
  assert.strictEqual(r(REMOTE, 'mine.txt'), 'laptop wins');
});

test('Toggle Sync pauses copying, then catches up on resume', async () => {
  await run('tether.toggleSync');
  assert.match(status(), /paused/);
  w(LOCAL, 'while-paused.txt', 'x');
  touch('while-paused.txt');
  await new Promise((res) => setTimeout(res, 800));
  assert.ok(!fs.existsSync(path.join(REMOTE, 'while-paused.txt')));
  await run('tether.toggleSync');
  await until('catch-up', () => fs.existsSync(path.join(REMOTE, 'while-paused.txt')));
});

test('dropped connection: goes offline, reconnects by itself, sends offline edits', async () => {
  execSync(`pkill -f 'sshd(-session)?: .*@notty' || true`); // kill the server side of our session
  await until('offline', () => /offline/.test(status()));
  w(LOCAL, 'offline.txt', 'typed with no connection');
  touch('offline.txt');
  await until('reconnected and synced', () => fs.existsSync(path.join(REMOTE, 'offline.txt')) && /in sync/.test(status()), 30000);
  assert.ok(!fake.messages.some((m) => m.kind === 'error'), 'no error popups during background reconnect');
});

test('"Open a Folder from a Server" pairs a new local folder and asks VS Code to open it', async () => {
  const other = path.join(work, 'remote2');
  fs.mkdirSync(other);
  w(other, 'hello.txt', 'hi');
  const dest = path.join(work, 'picked');
  fs.mkdirSync(dest);
  fake.onQuickPick = (items, o) => {
    if (/choose a server/.test(o.title)) return items.find((i) => i.value === TARGET);
    if (/choose the folder/.test(o.title)) return items.find((i) => i.action === 'type');
    if (/working copy/.test(o.title)) return items.find((i) => i.action === 'choose');
  };
  fake.onInput = () => other;
  fake.onOpenDialog = () => [Uri.file(dest)];
  await run('tether.openRemote');
  const opened = fake.executed.find((e) => e.id === 'vscode.openFolder');
  assert.ok(opened, 'vscode.openFolder was requested');
  assert.strictEqual(opened.args[0].fsPath, dest);
  assert.deepStrictEqual(opened.args[1], { forceNewWindow: true });
});

test('Disconnect, then deactivate cleanly', async () => {
  // Keep alive / Terminate prompt appears only when a remote terminal is open.
  fake.onMessage = () => 'Keep alive';
  await run('tether.disconnect');
  assert.match(status(), /disconnected/);
  await extension.deactivate();
  fs.rmSync(work, { recursive: true, force: true });
});
