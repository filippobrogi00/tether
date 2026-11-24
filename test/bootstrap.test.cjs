// The first-sync archive must contain only the files it was given.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { packLocalArchive } = require('../out-test/core.js');

test('local archive packs the requested files and nothing else', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-tar-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-tar-out-'));
  const archive = path.join(out, 'pack.tgz');
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'nested dir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(root, 'nested dir', 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(root, '-weird.txt'), 'dash');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, '.git', 'FETCH_HEAD'), 'should-not-ship\n');

    await packLocalArchive(root, archive, ['keep.txt', 'nested dir/a.txt', '-weird.txt']);

    const extracted = path.join(out, 'extracted');
    fs.mkdirSync(extracted);
    const tar = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
    assert.strictEqual(tar.status, 0, tar.stderr);
    assert.strictEqual(fs.readFileSync(path.join(extracted, 'keep.txt'), 'utf8'), 'keep');
    assert.strictEqual(fs.readFileSync(path.join(extracted, 'nested dir', 'a.txt'), 'utf8'), 'aaa');
    assert.strictEqual(fs.readFileSync(path.join(extracted, '-weird.txt'), 'utf8'), 'dash');
    assert.ok(!fs.existsSync(path.join(extracted, '.git')), 'ignored git metadata must not ride along in the archive');
    assert.ok(!fs.readdirSync(extracted).some((n) => n.startsWith('._')), 'macOS AppleDouble sidecars must not be archived');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
