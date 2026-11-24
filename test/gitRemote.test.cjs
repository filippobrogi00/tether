const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readLocalGit, remoteGitBootstrapCommand, shellQuote } = require('../out-test/core.js');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Tether',
  GIT_AUTHOR_EMAIL: 'tether@example.com',
  GIT_COMMITTER_NAME: 'Tether',
  GIT_COMMITTER_EMAIL: 'tether@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, args) {
  execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' });
}

test('bootstrap command inits, adds origin, and sets upstream without fetching', () => {
  const cmd = remoteGitBootstrapCommand('/home/ubuntu/davinci', {
    originUrl: "git@github.com:Org/it's-a-repo.git",
    branch: 'feature/servo',
    upstreamBranch: 'main',
  });
  assert.match(cmd, /git init --quiet \./);
  assert.ok(cmd.includes(`git remote add origin ${shellQuote("git@github.com:Org/it's-a-repo.git")}`));
  assert.match(cmd, /git symbolic-ref HEAD 'refs\/heads\/feature\/servo'/);
  assert.match(cmd, /git config 'branch\.feature\/servo\.remote' origin/);
  assert.match(cmd, /git config 'branch\.feature\/servo\.merge' 'refs\/heads\/main'/);
  assert.doesNotMatch(cmd, /\bgit fetch\b/);
  assert.doesNotMatch(cmd, /\bgit checkout\b/);
  assert.doesNotMatch(cmd, /\bgit reset\b/);
});

test('readLocalGit reports origin and upstream, and ignores a plain folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-git-'));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-plain-'));
  try {
    assert.strictEqual(await readLocalGit(plain), undefined);
    git(root, ['init', '-b', 'main']);
    git(root, ['commit', '--allow-empty', '-m', 'init']);
    git(root, ['remote', 'add', 'origin', 'git@github.com:Org/repo.git']);
    git(root, ['config', 'branch.main.remote', 'origin']);
    git(root, ['config', 'branch.main.merge', 'refs/heads/main']);
    const info = await readLocalGit(root);
    assert.deepStrictEqual(info, {
      originUrl: 'git@github.com:Org/repo.git',
      branch: 'main',
      upstreamBranch: 'main',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});
