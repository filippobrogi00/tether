import * as crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { Connection } from './core/connection';
import { shellQuote } from './core/scan';

export type Multiplexer = 'tmux' | 'screen' | 'none';

export interface RemoteTerminalHandle {
  /** VS Code terminal display name. */
  name: string;
  /** Multiplexer session name on the server (empty when multiplexer is none). */
  sessionId: string;
  mux: Multiplexer;
  terminal: vscode.Terminal;
  /** Kill the remote multiplexer session (or close the bare PTY). */
  terminateRemote: () => Promise<void>;
  /** Detach only — leave tmux/screen running. */
  detach: () => void;
}

const INPUT_CAP = 64 * 1024;
const WRITE_CHUNK = 8192;
const DRAIN_MS = 8000;
const START_MS = 15_000;

/**
 * A VS Code terminal whose shell runs on the server, in the synced folder.
 *
 * The shell uses its own SSH connection, so a sync cannot stall it. tmux (then
 * screen) keeps the session when that connection drops; the panel reattaches
 * instead of sitting open and ignoring keystrokes.
 */
export function openRemoteTerminal(
  getConn: () => Connection | undefined,
  openDedicated: () => Promise<Connection>,
  remoteDir: string,
  name: string,
  onCommand: () => void,
  opts?: { sessionId?: string; log?: (m: string) => void },
): RemoteTerminalHandle {
  const output = new vscode.EventEmitter<string>();
  const closed = new vscode.EventEmitter<number | void>();
  let channel: ClientChannel | undefined;
  let channelGen = 0;
  let shellConn: Connection | undefined;
  let shellOwned = false;
  let linkGen = 0;
  let mux: Multiplexer = 'none';
  let rows = 24;
  let cols = 80;
  let stopped = false;
  let attaching = false;
  let flushing = false;
  let warnedShared = false;
  let retry = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  let inputBuf = '';
  const sessionId = opts?.sessionId || makeSessionId(name, remoteDir);

  const log = (m: string) => opts?.log?.(m);

  function fire(text: string) {
    for (let i = 0; i < text.length; i += WRITE_CHUNK) output.fire(text.slice(i, i + WRITE_CHUNK));
  }

  function scheduleReattach() {
    if (stopped || retryTimer) return;
    const delay = Math.min(1000 * 2 ** retry, 15_000);
    retry++;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!stopped) void attach(true);
    }, delay);
  }

  function watchLink(conn: Connection) {
    const gen = ++linkGen;
    conn.once('close', () => {
      if (stopped || gen !== linkGen) return;
      channel = undefined;
      shellConn = undefined;
      shellOwned = false;
      scheduleReattach();
    });
  }

  function dropChannel(ch: ClientChannel | undefined) {
    if (!ch) return;
    channelGen++;
    if (channel === ch) channel = undefined;
    try {
      ch.close();
    } catch {
      /* already closing */
    }
  }

  async function flushInput() {
    if (flushing) return;
    flushing = true;
    try {
      while (inputBuf && channel && !stopped) {
        const ch = channel;
        const chunk = inputBuf;
        inputBuf = '';
        let accepted = true;
        try {
          accepted = ch.write(chunk) !== false;
        } catch {
          inputBuf = chunk + inputBuf;
          if (inputBuf.length > INPUT_CAP) inputBuf = inputBuf.slice(-INPUT_CAP);
          dropChannel(ch);
          scheduleReattach();
          return;
        }
        if (!accepted) {
          const drained = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), DRAIN_MS);
            ch.once('drain', () => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          if (!drained && channel === ch && !stopped) {
            // The server stopped reading. The panel would otherwise stay open and ignore keys.
            dropChannel(ch);
            scheduleReattach();
            return;
          }
        }
      }
    } finally {
      flushing = false;
      if (inputBuf && channel && !stopped) void flushInput();
    }
  }

  function bind(ch: ClientChannel) {
    const gen = ++channelGen;
    channel = ch;
    const out = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let exitCode: number | null = null;
    let sawExit = false;
    const fail = (userExit: boolean) => {
      if (stopped || channelGen !== gen) return;
      channelGen++;
      if (channel === ch) channel = undefined;
      if (userExit) {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        closed.fire(exitCode ?? 0);
        if (shellOwned && shellConn && !shellConn.closed) shellConn.close();
        return;
      }
      scheduleReattach();
    };
    ch.on('data', (d: Buffer) => {
      if (channelGen === gen) fire(out.write(d));
    });
    ch.stderr.on('data', (d: Buffer) => {
      if (channelGen === gen) fire(errDec.write(d));
    });
    ch.on('exit', (code: number | null) => {
      sawExit = true;
      exitCode = code;
    });
    ch.on('error', () => {
      try {
        ch.close();
      } catch {
        /* already closing */
      }
      fail(false);
    });
    ch.on('close', () => fail(sawExit && exitCode === 0));
    try {
      ch.setWindow(rows, cols, 0, 0);
    } catch {
      /* the next resize will retry */
    }
    void flushInput();
  }

  async function execPty(conn: Connection, cmd: string): Promise<ClientChannel> {
    const pending = conn.execPty(cmd, { term: 'xterm-256color', cols, rows });
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The remote shell did not start')), START_MS);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (err) {
      void pending.then((ch) => ch.close()).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer!);
    }
  }

  async function acquire(): Promise<boolean> {
    if (shellConn && !shellConn.closed) return true;
    try {
      const conn = await openDedicated();
      if (stopped) {
        conn.close();
        return false;
      }
      linkGen++;
      shellConn = conn;
      shellOwned = true;
      watchLink(conn);
      return true;
    } catch (err) {
      const shared = getConn();
      if (!shared || shared.closed || stopped) {
        log(`Remote terminal could not connect: ${(err as Error).message}`);
        return false;
      }
      if (!warnedShared) {
        warnedShared = true;
        log(`Remote terminal is sharing the sync connection (${(err as Error).message}).`);
      }
      linkGen++;
      shellConn = shared;
      shellOwned = false;
      watchLink(shared);
      return true;
    }
  }

  async function attach(isRetry: boolean) {
    if (stopped || attaching) return;
    attaching = true;
    try {
      if (isRetry) fire('\r\nTether: reconnecting…\r\n');
      if (!(await acquire())) {
        scheduleReattach();
        return;
      }
      if (stopped || !shellConn || shellConn.closed) return;
      mux = await pickMultiplexer(shellConn);
      if (stopped) return;
      const cmd = buildShellCommand(remoteDir, mux, sessionId);
      const ch = await execPty(shellConn, cmd);
      if (stopped) {
        ch.close();
        return;
      }
      bind(ch);
      retry = 0;
      if (isRetry) {
        const how = mux === 'none' ? 'started a new shell' : `reattached to ${mux} (${sessionId})`;
        fire(`Tether: ${how}.\r\n`);
        log(`Remote terminal ${how}.`);
      } else if (mux === 'none') {
        log('No tmux/screen on the server; the shell cannot survive a dropped connection.');
      } else {
        log(`Remote terminal using ${mux} session ${sessionId}`);
      }
    } catch (err) {
      if (stopped) return;
      log(`Remote terminal reconnect failed: ${(err as Error).message}`);
      if (shellOwned && shellConn && !shellConn.closed) {
        const dead = shellConn;
        linkGen++;
        shellConn = undefined;
        shellOwned = false;
        dead.close();
      }
      fire(`\r\nTether: ${(err as Error).message}\r\n`);
      scheduleReattach();
    } finally {
      attaching = false;
    }
  }

  function release(killOwned: boolean) {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    const ch = channel;
    channel = undefined;
    channelGen++;
    try {
      ch?.close();
    } catch {
      /* already closing */
    }
    if (killOwned && shellOwned && shellConn && !shellConn.closed) shellConn.close();
    shellConn = undefined;
    shellOwned = false;
  }

  const pty: vscode.Pseudoterminal = {
    onDidWrite: output.event,
    onDidClose: closed.event,
    open(dims) {
      if (dims?.rows) rows = dims.rows;
      if (dims?.columns) cols = dims.columns;
      fire('Tether: connecting…\r\n');
      void attach(false);
    },
    close() {
      release(true);
    },
    handleInput(data) {
      inputBuf += data;
      if (inputBuf.length > INPUT_CAP) inputBuf = inputBuf.slice(-INPUT_CAP);
      void flushInput();
      if (data.includes('\r')) onCommand();
    },
    setDimensions(d) {
      rows = d.rows;
      cols = d.columns;
      try {
        channel?.setWindow(rows, cols, 0, 0);
      } catch {
        /* channel is being replaced */
      }
    },
  };

  const green = new vscode.ThemeColor('testing.iconPassed');
  const terminal = vscode.window.createTerminal({
    name,
    pty,
    iconPath: new vscode.ThemeIcon('remote', green),
    color: green,
  });

  const handle: RemoteTerminalHandle = {
    name,
    sessionId,
    get mux() {
      return mux;
    },
    terminal,
    detach() {
      release(true);
    },
    async terminateRemote() {
      const conn = shellConn && !shellConn.closed ? shellConn : getConn();
      const owned = shellOwned && shellConn === conn;
      const m = mux;
      const id = sessionId;
      release(false);
      try {
        if (conn && !conn.closed && m !== 'none') {
          if (m === 'tmux') await conn.exec(`tmux kill-session -t ${shellQuote(id)} 2>/dev/null || true`);
          else if (m === 'screen') await conn.exec(`screen -S ${shellQuote(id)} -X quit 2>/dev/null || true`);
        }
      } catch {
        /* best effort */
      }
      if (owned && conn && !conn.closed) conn.close();
    },
  };

  return handle;
}

async function pickMultiplexer(conn: Connection): Promise<Multiplexer> {
  if (conn.caps.tmux === undefined) {
    try {
      conn.caps.tmux = (await conn.exec('command -v tmux >/dev/null 2>&1')).code === 0;
    } catch {
      conn.caps.tmux = false;
    }
  }
  if (conn.caps.tmux) return 'tmux';

  if (conn.caps.screen === undefined) {
    try {
      conn.caps.screen = (await conn.exec('command -v screen >/dev/null 2>&1')).code === 0;
    } catch {
      conn.caps.screen = false;
    }
  }
  if (conn.caps.screen) return 'screen';
  return 'none';
}

function makeSessionId(name: string, remoteDir: string): string {
  const hash = crypto.createHash('sha1').update(`${name}\0${remoteDir}`).digest('hex').slice(0, 10);
  return `tether-${hash}`;
}

function buildShellCommand(remoteDir: string, mux: Multiplexer, sessionId: string): string {
  const dir = shellQuote(remoteDir);
  if (mux === 'tmux') {
    // -A attaches if the session already exists, so a new SSH connection
    // returns to the same shell instead of starting a blank one.
    return `cd -- ${dir} && exec tmux new-session -A -s ${shellQuote(sessionId)}`;
  }
  if (mux === 'screen') {
    return `cd -- ${dir} && exec screen -D -RR ${shellQuote(sessionId)}`;
  }
  return `cd -- ${dir} && exec $SHELL -l`;
}

/**
 * Ask whether to kill keep-alive remote shells before tearing down SSH.
 * Returns true if the user chose Terminate (or there were no terminals).
 */
export async function confirmRemoteTerminals(handles: RemoteTerminalHandle[]): Promise<'terminate' | 'keep' | 'none'> {
  const alive = handles.filter((h) => {
    try {
      // dispose state: exitStatus set when closed
      return h.terminal.exitStatus === undefined;
    } catch {
      return false;
    }
  });
  if (alive.length === 0) return 'none';

  const message =
    alive.length === 1
      ? `Terminate remote terminal ${alive[0].name}?`
      : 'Terminate remote terminals?';
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Terminate', 'Keep alive');
  if (choice === 'Terminate') {
    await Promise.all(alive.map((h) => h.terminateRemote()));
    for (const h of alive) {
      try {
        h.terminal.dispose();
      } catch {
        /* already gone */
      }
    }
    return 'terminate';
  }
  // Keep alive (or dismiss): detach only.
  for (const h of alive) h.detach();
  for (const h of alive) {
    try {
      h.terminal.dispose();
    } catch {
      /* already gone */
    }
  }
  return 'keep';
}
