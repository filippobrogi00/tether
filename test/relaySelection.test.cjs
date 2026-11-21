// Unit tests for Explorer → Relay source mapping. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveRelaySelection, localToRemote, tetherUriToRemote } = require('../out-test/core.js');

const sessions = [
  { target: 'dev', localRoot: '/Users/me/proj', remoteRoot: '/home/me/proj' },
  { target: 'prod', localRoot: '/Users/me/other', remoteRoot: '/var/www' },
];

test('tether Uri maps through the Remote View root', () => {
  assert.strictEqual(tetherUriToRemote('/src/a.ts', '/home/me/proj'), '/home/me/proj/src/a.ts');
  assert.strictEqual(tetherUriToRemote('/', '/home/me/proj'), '/home/me/proj');
});

test('local path maps into the paired remote root', () => {
  assert.strictEqual(
    localToRemote(path.join('/Users/me/proj', 'src', 'a.ts'), '/Users/me/proj', '/home/me/proj'),
    '/home/me/proj/src/a.ts',
  );
  assert.strictEqual(localToRemote('/Users/me/elsewhere/x', '/Users/me/proj', '/home/me/proj'), undefined);
});

test('empty selection is rejected so the caller can fall back to the picker', () => {
  const r = resolveRelaySelection([], sessions);
  assert.strictEqual(r.ok, false);
});

test('Remote View multi-select on one host becomes source paths', () => {
  const r = resolveRelaySelection(
    [
      { scheme: 'tether', authority: 'dev', path: '/a.txt', fsPath: '/a.txt' },
      { scheme: 'tether', authority: encodeURIComponent('dev'), path: '/dir', fsPath: '/dir' },
    ],
    sessions,
  );
  assert.deepStrictEqual(r, {
    ok: true,
    target: 'dev',
    paths: ['/home/me/proj/a.txt', '/home/me/proj/dir'],
  });
});

test('local Explorer selection under a paired folder maps to remote paths', () => {
  const r = resolveRelaySelection(
    [
      {
        scheme: 'file',
        authority: '',
        path: '/Users/me/proj/readme.md',
        fsPath: path.join('/Users/me/proj', 'readme.md'),
      },
    ],
    sessions,
  );
  assert.deepStrictEqual(r, { ok: true, target: 'dev', paths: ['/home/me/proj/readme.md'] });
});

test('mixed source hosts are rejected', () => {
  const r = resolveRelaySelection(
    [
      { scheme: 'tether', authority: 'dev', path: '/a', fsPath: '/a' },
      { scheme: 'tether', authority: 'prod', path: '/b', fsPath: '/b' },
    ],
    sessions,
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /same source server/);
});

test('unpaired local files are rejected', () => {
  const r = resolveRelaySelection(
    [{ scheme: 'file', authority: '', path: '/tmp/x', fsPath: '/tmp/x' }],
    sessions,
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /paired with Tether/);
});
