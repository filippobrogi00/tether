import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import { AnyAuthMethod, AuthenticationType, Client, ClientChannel, PseudoTtyOptions, SFTPWrapper, utils } from 'ssh2';
import { KnownHosts } from './knownHosts';
import { ResolvedHost, resolveHost } from './sshConfig';
import { FileStat, Logger, Prompter } from './types';

export interface ConnectDeps {
  prompter: Prompter;
  log: Logger;
  knownHosts: KnownHosts;
  readyTimeoutMs?: number;
}

export interface RemoteStat extends FileStat {
  isDir: boolean;
}

export interface RemoteDirEntry extends RemoteStat {
  name: string;
  isFile: boolean;
}

export class UserCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

const SFTP_NO_SUCH_FILE = 2;

/**
 * One authenticated SSH connection (through jump hosts if configured), exposing
 * the few operations the sync engine needs. Pure JavaScript via `ssh2`, so it
 * behaves the same on Windows, macOS and Linux and needs nothing installed on
 * either side beyond a standard SSH server.
 */
export class Connection extends EventEmitter {
  /** Remote home directory, used to resolve `~` and relative paths. */
  home = '/';
  closed = false;
  /** Capabilities discovered lazily; `undefined` = not probed yet. */
  caps: {
    find?: boolean;
    hashCmd?: string | null;
    posixRename?: boolean;
    tar?: boolean;
    gzip?: boolean;
    rsync?: boolean;
    tmux?: boolean;
    screen?: boolean;
  } = {};
  private readonly knownDirs = new Set<string>();
  private readonly makingDirs = new Map<string, Promise<void>>();

  private constructor(
    readonly host: ResolvedHost,
    private readonly client: Client,
    private readonly jumps: Client[],
    private readonly sftp: SFTPWrapper,
    private readonly log: Logger,
  ) {
    super();
    const onClose = () => {
      if (this.closed) return;
      this.closed = true;
      for (const j of this.jumps) j.end();
      this.emit('close');
    };
    client.on('close', onClose);
    client.on('end', onClose);
    client.on('error', (err) => {
      this.log.warn(`Connection error: ${err.message}`);
      onClose();
    });
  }

  static async open(target: string, deps: ConnectDeps): Promise<Connection> {
    const resolved = resolveHost(target);
    if (resolved.unsupported) {
      throw new Error(
        `"${target}" uses ${resolved.unsupported} in your SSH config, which Tether does not support yet. ProxyJump works.`,
      );
    }
    const chain = [...(resolved.proxyJump ?? []).map(resolveHost), resolved];
    const clients: Client[] = [];
    try {
      let sock: Duplex | undefined;
      for (let i = 0; i < chain.length; i++) {
        const client = await connectOne(chain[i], sock, deps);
        clients.push(client);
        if (i < chain.length - 1) {
          const next = chain[i + 1];
          sock = await new Promise<Duplex>((res, rej) =>
            client.forwardOut('127.0.0.1', 0, next.hostName, next.port, (err, ch) => (err ? rej(err) : res(ch))),
          );
        }
      }
      const client = clients[clients.length - 1];
      const sftp = await new Promise<SFTPWrapper>((res, rej) => client.sftp((err, s) => (err ? rej(err) : res(s))));
      const conn = new Connection(resolved, client, clients.slice(0, -1), sftp, deps.log);
      conn.home = await new Promise<string>((res) => sftp.realpath('.', (err, p) => res(err ? '/' : p)));
      return conn;
    } catch (err) {
      for (const c of clients) c.end();
      throw err;
    }
  }

  get label(): string {
    return this.host.alias;
  }

  close(): void {
    if (this.closed) return;
    this.client.end();
  }

  /** Turn `~`, `~/x` or a relative path into an absolute remote path. */
  resolvePath(p: string): string {
    if (p === '~' || p === '') return this.home;
    if (p.startsWith('~/')) return joinPosix(this.home, p.slice(2));
    if (!p.startsWith('/')) return joinPosix(this.home, p);
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
  }

  exec(command: string, stdin?: Buffer | string): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        const out: Buffer[] = [];
        let stderr = '';
        stream.on('data', (d: Buffer) => out.push(d));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        stream.on('close', (code: number | null) => resolve({ code, stdout: Buffer.concat(out), stderr }));
        stream.on('error', reject);
        stream.end(stdin);
      });
    });
  }

  /** Run a command attached to a terminal (used for the interactive remote shell). */
  execPty(command: string, pty: PseudoTtyOptions): Promise<ClientChannel> {
    return new Promise((res, rej) => this.client.exec(command, { pty }, (err, ch) => (err ? rej(err) : res(ch))));
  }

  /** Open a TCP stream to host:port as seen from the server (for port forwarding). */
  forward(remoteHost: string, remotePort: number): Promise<Duplex> {
    return new Promise((res, rej) =>
      this.client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, ch) => (err ? rej(err) : res(ch))),
    );
  }

  // ---- SFTP ---------------------------------------------------------------

  stat(p: string): Promise<RemoteStat | undefined> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(p, (err, a) => {
        if (err) return isMissing(err) ? resolve(undefined) : reject(err);
        resolve({ size: a.size, mtime: a.mtime, mode: a.mode & 0o7777, isDir: a.isDirectory() });
      });
    });
  }

  readdir(p: string): Promise<RemoteDirEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(p, (err, list) => {
        if (err) return reject(err);
        resolve(
          list.map((e) => {
            // ssh2 gives readdir entries full Stats objects at runtime; the typings only declare Attributes.
            const a = e.attrs as unknown as import('ssh2').Stats;
            return {
              name: e.filename,
              size: a.size,
              mtime: a.mtime,
              mode: a.mode & 0o7777,
              isDir: a.isDirectory(),
              isFile: a.isFile(),
            };
          }),
        );
      });
    });
  }

  /** Create a folder and any missing parents. Concurrent calls for the same folder share one attempt. */
  mkdirp(dir: string): Promise<void> {
    if (dir === '/' || dir === '' || this.knownDirs.has(dir)) return Promise.resolve();
    let pending = this.makingDirs.get(dir);
    if (!pending) {
      pending = this.makeDir(dir).finally(() => this.makingDirs.delete(dir));
      this.makingDirs.set(dir, pending);
    }
    return pending;
  }

  private async makeDir(dir: string): Promise<void> {
    const mkdir = () => new Promise<boolean>((res) => this.sftp.mkdir(dir, (err) => res(!err)));
    if (!(await mkdir())) {
      let st = await this.stat(dir).catch(() => undefined);
      if (!st) {
        await this.mkdirp(dirname(dir));
        if (!(await mkdir())) st = await this.stat(dir); // someone else may have created it meanwhile
        else st = { size: 0, mtime: 0, isDir: true };
      }
      if (!st) throw new Error(`Could not create the folder ${dir} on the server`);
      if (!st.isDir) throw new Error(`${dir} exists on the server but is not a folder`);
    }
    this.knownDirs.add(dir);
  }

  noteDir(dir: string): void {
    this.knownDirs.add(dir);
  }

  /**
   * Upload a local file. Unless `stable` is set, the bytes are copied to a temp
   * file first: ssh2's fastPut keeps reading until the size it saw at open, so a
   * file that shrinks mid-read (git truncating FETCH_HEAD, a build replacing an
   * output) never finishes and the sync stays in flight.
   */
  put(localPath: string, remotePath: string, opts?: { stable?: boolean }): Promise<void> {
    if (opts?.stable) return this.fastPut(localPath, remotePath);
    return this.putSnapshot(localPath, remotePath);
  }

  private fastPut(localPath: string, remotePath: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.fastPut(localPath, remotePath, (err) => (err ? rej(err) : res())));
  }

  private async putSnapshot(localPath: string, remotePath: string): Promise<void> {
    const snap = path.join(os.tmpdir(), `.tether-put-${crypto.randomBytes(6).toString('hex')}`);
    try {
      await fs.promises.copyFile(localPath, snap);
      if (process.platform !== 'win32') {
        const st = await fs.promises.stat(localPath).catch(() => undefined);
        if (st) await fs.promises.chmod(snap, st.mode & 0o777).catch(() => undefined);
      }
      await this.fastPut(snap, remotePath);
    } finally {
      await fs.promises.rm(snap, { force: true }).catch(() => undefined);
    }
  }

  get(remotePath: string, localPath: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.fastGet(remotePath, localPath, (err) => (err ? rej(err) : res())));
  }

  chmod(p: string, mode: number): Promise<void> {
    return new Promise((res) => this.sftp.chmod(p, mode, () => res()));
  }

  /** Replace `to` with `from` atomically where the server allows it. */
  async rename(from: string, to: string): Promise<void> {
    if (this.caps.posixRename !== false) {
      const ok = await new Promise<boolean>((res) => {
        try {
          this.sftp.ext_openssh_rename(from, to, (err) => res(!err));
        } catch {
          res(false);
        }
      });
      if (ok) {
        this.caps.posixRename = true;
        return;
      }
      if (this.caps.posixRename === undefined) this.caps.posixRename = false;
    }
    await this.unlink(to);
    await new Promise<void>((res, rej) => this.sftp.rename(from, to, (err) => (err ? rej(err) : res())));
  }

  /** Delete a file; a file that is already gone is not an error. */
  unlink(p: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.unlink(p, (err) => (err && !isMissing(err) ? rej(err) : res())));
  }

  /** Remove a folder if it is empty; resolves to whether it was removed. */
  rmdirIfEmpty(p: string): Promise<boolean> {
    return new Promise((res) =>
      this.sftp.rmdir(p, (err) => {
        if (!err) this.knownDirs.delete(p);
        res(!err);
      }),
    );
  }
}

// ---- helpers ---------------------------------------------------------------

export function joinPosix(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function isMissing(err: unknown): boolean {
  return (err as { code?: unknown }).code === SFTP_NO_SUCH_FILE;
}

function defaultAgent(h: ResolvedHost): string | undefined {
  if (h.identityAgent) return h.identityAgent;
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') {
    // Windows' built-in OpenSSH agent, when its service is running.
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    return fs.existsSync(pipe) ? pipe : undefined;
  }
  return undefined;
}

interface Attempt {
  method: 'publickey' | 'password' | 'keyboard-interactive';
  build(): Promise<AnyAuthMethod | undefined>;
}

function buildAuthAttempts(h: ResolvedHost, label: string, deps: ConnectDeps, cancel: () => void): Attempt[] {
  const username = h.user;
  const attempts: Attempt[] = [];

  const agent = defaultAgent(h);
  if (agent) attempts.push({ method: 'publickey', build: async () => ({ type: 'agent', username, agent }) });

  for (const file of h.identityFiles) {
    attempts.push({
      method: 'publickey',
      build: async () => {
        let key: Buffer;
        try {
          key = await fs.promises.readFile(file);
        } catch {
          return undefined; // key file does not exist: skip silently
        }
        let passphrase: string | undefined;
        let parsed = utils.parseKey(key);
        if (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message)) {
          passphrase = await deps.prompter.passphrase(file);
          if (passphrase === undefined) return undefined;
          parsed = utils.parseKey(key, passphrase);
        }
        if (parsed instanceof Error) {
          deps.log.warn(`Skipping key ${file}: ${parsed.message}`);
          return undefined;
        }
        return { type: 'publickey', username, key, passphrase };
      },
    });
  }

  for (let i = 0; i < 3; i++) {
    attempts.push({
      method: 'password',
      build: async () => {
        const password = await deps.prompter.password(label, i);
        if (password === undefined) {
          cancel();
          return undefined;
        }
        return { type: 'password', username, password };
      },
    });
  }

  attempts.push({
    method: 'keyboard-interactive',
    build: async () => ({
      type: 'keyboard-interactive',
      username,
      prompt: (_name, instructions, _lang, prompts, finish) => {
        if (prompts.length === 0) return finish([]);
        deps.prompter
          .keyboardInteractive(label, instructions, prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })))
          .then((answers) => {
            if (!answers) cancel();
            finish(answers ?? []);
          })
          .catch(() => finish([]));
      },
    }),
  });

  return attempts;
}

function connectOne(h: ResolvedHost, sock: Duplex | undefined, deps: ConnectDeps): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const label = `${h.user}@${h.hostName}${h.port !== 22 ? ':' + h.port : ''}`;
    let settled = false;
    let cancelled = false;
    let hostKeyRejected: string | undefined;
    const attempts = buildAuthAttempts(h, label, deps, () => (cancelled = true));

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };

    client.on('ready', () => {
      settled = true;
      resolve(client);
    });
    client.on('error', (err: Error & { level?: string }) => {
      if (cancelled) return fail(new UserCancelled());
      if (hostKeyRejected) return fail(new Error(hostKeyRejected));
      if (err.level === 'client-authentication') {
        return fail(new Error(`Could not sign in to ${label}. Check the username, password or SSH key.`));
      }
      fail(new Error(`Could not connect to ${label}: ${err.message}`));
    });
    client.on('close', () => fail(new Error(`Connection to ${label} closed before it was ready.`)));

    let first = true;
    client.connect({
      host: h.hostName,
      port: h.port,
      username: h.user,
      sock,
      readyTimeout: deps.readyTimeoutMs ?? 30_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const status = deps.knownHosts.check(h.hostName, h.port, key);
        if (status === 'trusted') return verify(true);
        const fp = KnownHosts.fingerprint(key);
        if (status === 'changed') {
          hostKeyRejected =
            `The identity of ${h.hostName} has CHANGED (new key ${fp}). This can mean someone is intercepting the ` +
            `connection, or the server was reinstalled. Tether refused to connect. If the change is expected, ` +
            `remove the old entry with "ssh-keygen -R ${h.hostName}" and try again.`;
          return verify(false);
        }
        deps.prompter
          .confirmHostKey(label, KnownHosts.keyType(key), fp)
          .then((ok) => {
            if (ok) deps.knownHosts.trust(h.hostName, h.port, key);
            else cancelled = true;
            verify(ok);
          })
          .catch(() => verify(false));
      },
      authHandler: (left: AuthenticationType[] | null, _partial: boolean, next: (m: AnyAuthMethod) => void) => {
        if (first) {
          first = false;
          return next({ type: 'none', username: h.user }); // asks the server which methods it accepts
        }
        void (async () => {
          while (attempts.length && !cancelled) {
            const attempt = attempts.shift()!;
            if (left && !left.includes(attempt.method)) continue;
            try {
              const method = await attempt.build();
              if (method && !cancelled) return next(method);
            } catch (err) {
              deps.log.warn(`Auth step failed: ${(err as Error).message}`);
            }
          }
          (next as (m: unknown) => void)(false); // nothing left to try
        })();
      },
    });
    // SFTP is many tiny request/response packets. Without TCP_NODELAY each one waits ~40 ms
    // on Nagle's algorithm + delayed ACKs, which makes syncing many small files crawl.
    client.setNoDelay(true);
  });
}
