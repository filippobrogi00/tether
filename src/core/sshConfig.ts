import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';

export interface ResolvedHost {
  /** What the user typed or picked: an alias from ~/.ssh/config or `user@host[:port]`. */
  alias: string;
  hostName: string;
  user: string;
  port: number;
  identityFiles: string[];
  identityAgent?: string;
  proxyJump?: string[];
  unsupported?: string;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function sshDir(): string {
  return path.join(os.homedir(), '.ssh');
}

/** Read ~/.ssh/config, inlining `Include` directives (one level of globbing on the file name). */
function readConfigText(file: string, depth = 0): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  if (depth > 4) return text;
  return text.replace(/^[ \t]*Include[ \t=]+(.+)$/gim, (_line, spec: string) => {
    const parts: string[] = [];
    for (let pattern of spec.trim().split(/\s+/)) {
      pattern = expandHome(pattern.replace(/^"|"$/g, ''));
      if (!path.isAbsolute(pattern)) pattern = path.join(sshDir(), pattern);
      const dir = path.dirname(pattern);
      const nameRe = new RegExp(
        '^' +
          path
            .basename(pattern)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
      );
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((n) => nameRe.test(n)).sort();
      } catch {
        /* missing include dir is fine */
      }
      for (const n of names) parts.push(readConfigText(path.join(dir, n), depth + 1));
    }
    return parts.join('\n');
  });
}

function loadConfig(): SSHConfig {
  return SSHConfig.parse(readConfigText(path.join(sshDir(), 'config')));
}

/** Concrete host aliases from ~/.ssh/config (wildcard patterns are skipped). */
export function listConfiguredHosts(): string[] {
  const hosts = new Set<string>();
  const walk = (cfg: SSHConfig) => {
    for (const line of cfg) {
      if (line.type !== SSHConfig.DIRECTIVE) continue;
      if (line.param.toLowerCase() === 'host') {
        const values = Array.isArray(line.value) ? line.value.map((v) => v.val) : [line.value];
        for (const v of values) if (v && !/[*?!]/.test(v)) hosts.add(v);
      }
    }
  };
  walk(loadConfig());
  return [...hosts];
}

/** Parse `user@host:port` (every part but host optional). */
export function parseTarget(target: string): { user?: string; host: string; port?: number } {
  let rest = target.trim().replace(/^ssh:\/\//, '');
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rest);
  if (m) {
    rest = m[1];
    port = Number(m[2]);
  }
  return { user, host: rest.replace(/^\[|\]$/g, ''), port };
}

/** Resolve an alias or `user@host[:port]` against ~/.ssh/config, like `ssh -G` would. */
export function resolveHost(target: string): ResolvedHost {
  const t = parseTarget(target);
  let c: Record<string, string | string[]> = {};
  try {
    // matchExec:false -> never run shell commands from `Match exec` while resolving.
    c = loadConfig().compute(t.host, { ignoreCase: true, matchExec: false });
  } catch {
    /* an unparsable config should not block a plain user@host connection */
  }
  const one = (k: string): string | undefined => {
    const v = c[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const many = (k: string): string[] => {
    const v = c[k];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };

  const hostName = (one('hostname') ?? t.host).replace(/%h/g, t.host);
  const user = t.user ?? one('user') ?? os.userInfo().username;
  const port = t.port ?? Number(one('port') ?? 22);

  let identityFiles = many('identityfile').map((f) =>
    expandHome(f.replace(/%d/g, os.homedir()).replace(/%u/g, os.userInfo().username).replace(/%h/g, hostName).replace(/%r/g, user)),
  );
  if (identityFiles.length === 0) {
    identityFiles = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => path.join(sshDir(), n));
  }

  const jump = one('proxyjump');
  const agent = one('identityagent');
  return {
    alias: target,
    hostName,
    user,
    port,
    identityFiles,
    identityAgent: agent && agent.toLowerCase() !== 'none' ? expandHome(agent.replace(/^"|"$/g, '')) : undefined,
    proxyJump: jump && jump.toLowerCase() !== 'none' ? jump.split(',').map((s) => s.trim()) : undefined,
    unsupported: one('proxycommand') && !jump ? 'ProxyCommand' : undefined,
  };
}
