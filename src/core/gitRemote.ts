import { execFile } from 'child_process';
import { shellQuote } from './scan';

/** What the local repository says about itself. Absent fields mean "don't set that". */
export interface LocalGitInfo {
  /** `remote.origin.url`, when the repo has an origin. */
  originUrl?: string;
  /** Current branch. Absent on a detached HEAD. */
  branch?: string;
  /** Branch name on origin that the current branch tracks, without the `origin/` prefix. */
  upstreamBranch?: string;
}

/**
 * Read origin URL and upstream from the local repo. Returns undefined when
 * `root` is not a git working tree. Never prompts (no credential helper dialog).
 */
export function readLocalGit(root: string): Promise<LocalGitInfo | undefined> {
  return read(root);
}

async function read(root: string): Promise<LocalGitInfo | undefined> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return undefined;
  const [originUrl, head, upstream] = await Promise.all([
    git(root, ['config', '--get', 'remote.origin.url']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']),
  ]);
  const branch = head && head !== 'HEAD' ? safeBranch(head) : undefined;
  let upstreamBranch = branch;
  if (upstream?.startsWith('origin/')) {
    const name = safeBranch(upstream.slice('origin/'.length));
    if (name) upstreamBranch = name;
  }
  return {
    originUrl: originUrl && !/[\r\n\0]/.test(originUrl) ? originUrl : undefined,
    branch,
    upstreamBranch: originUrl ? upstreamBranch : undefined,
  };
}

/**
 * Idempotent remote setup: `git init`, `remote add origin` from the local URL,
 * and the same upstream tracking `git branch -u` would write. Does not fetch,
 * checkout, or commit, so it cannot change the files that were just copied and
 * cannot wait on a credential prompt.
 */
export function remoteGitBootstrapCommand(remoteRoot: string, info: LocalGitInfo): string {
  const lines = [
    `cd -- ${shellQuote(remoteRoot)} || exit 1`,
    'command -v git >/dev/null 2>&1 || exit 2',
    'git init --quiet . || exit 1',
  ];
  if (info.branch) {
    const ref = shellQuote(`refs/heads/${info.branch}`);
    // Only an empty repo (no commits yet). Moving HEAD on a repo that already
    // has history would point the server at a different branch than its commits.
    lines.push(`if ! git rev-parse --verify -q HEAD >/dev/null 2>&1; then git symbolic-ref HEAD ${ref}; fi`);
  }
  if (info.originUrl) {
    const url = shellQuote(info.originUrl);
    lines.push(
      `if git remote get-url origin >/dev/null 2>&1; then cur=$(git remote get-url origin); if [ "$cur" != ${url} ]; then git remote set-url origin ${url} && echo ${shellQuote(`Tether: origin is now ${info.originUrl}`)}; fi; else git remote add origin ${url} && echo ${shellQuote(`Tether: origin is ${info.originUrl}`)}; fi`,
    );
  }
  if (info.branch && info.upstreamBranch && info.originUrl) {
    // Same keys `git branch --set-upstream-to=origin/<branch>` writes, without
    // requiring the remote-tracking ref to exist (that would need a fetch).
    lines.push(`git config ${shellQuote(`branch.${info.branch}.remote`)} origin`);
    lines.push(
      `git config ${shellQuote(`branch.${info.branch}.merge`)} ${shellQuote(`refs/heads/${info.upstreamBranch}`)}`,
    );
  }
  return lines.join('\n');
}

function safeBranch(name: string): string | undefined {
  if (!name || name.startsWith('-') || name.includes('..') || name.includes('@{')) return undefined;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return undefined;
  return name;
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      {
        timeout: 8000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      },
      (err, stdout) => resolve(err ? undefined : stdout.toString().trim() || undefined),
    );
  });
}
