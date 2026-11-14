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

/**
 * A VS Code terminal whose shell runs on the server, in the synced folder.
 *
 * Prefers tmux, then screen, so the remote shell survives disconnects / editor restarts.
 * Falls back to a direct login shell when neither is available.
 */
export function openRemoteTerminal(
  getConn: () => Connection | undefined,
  remoteDir: string,
  name: string,
  onCommand: () => void,
  opts?: { sessionId?: string; log?: (m: string) => void },
): RemoteTerminalHandle {
  const output = new vscode.EventEmitter<string>();
  const closed = new vscode.EventEmitter<number | void>();
  let channel: ClientChannel | undefined;
  let mux: Multiplexer = 'none';
  const sessionId = opts?.sessionId ?? makeSessionId(name, remoteDir);

  const pty: vscode.Pseudoterminal = {
    onDidWrite: output.event,
    onDidClose: closed.event,
    async open(dims) {
      const conn = getConn();
      if (!conn || conn.closed) {
        output.fire('Not connected to the server. Reconnect, then open a new terminal.\r\n');
        closed.fire(1);
        return;
      }
      try {
        mux = await pickMultiplexer(conn);
        const cmd = buildShellCommand(remoteDir, mux, sessionId);
        if (mux === 'none') opts?.log?.('No tmux/screen on the server; remote terminal will not keep alive after disconnect.');
        else opts?.log?.(`Remote terminal using ${mux} session ${sessionId}`);

        channel = await conn.execPty(cmd, {
          term: 'xterm-256color',
          cols: dims?.columns ?? 80,
          rows: dims?.rows ?? 24,
        });
        const out = new StringDecoder('utf8');
        const err = new StringDecoder('utf8');
        channel.on('data', (d: Buffer) => output.fire(out.write(d)));
        channel.stderr.on('data', (d: Buffer) => output.fire(err.write(d)));
        channel.on('close', () => closed.fire(0));
      } catch (e) {
        output.fire(`Could not start a shell on the server: ${(e as Error).message}\r\n`);
        closed.fire(1);
      }
    },
    close() {
      // Detach only — keep tmux/screen alive unless terminateRemote was used.
      channel?.close();
      channel = undefined;
    },
    handleInput(data) {
      channel?.write(data);
      if (data.includes('\r')) onCommand();
    },
    setDimensions(d) {
      channel?.setWindow(d.rows, d.columns, 0, 0);
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
      channel?.close();
      channel = undefined;
    },
    async terminateRemote() {
      const conn = getConn();
      const m = mux;
      const id = sessionId;
      channel?.close();
      channel = undefined;
      if (!conn || conn.closed || m === 'none') return;
      try {
        if (m === 'tmux') await conn.exec(`tmux kill-session -t ${shellQuote(id)} 2>/dev/null || true`);
        else if (m === 'screen') await conn.exec(`screen -S ${shellQuote(id)} -X quit 2>/dev/null || true`);
      } catch {
        /* best effort */
      }
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

function buildShellCommand(remoteDir: string, mux: Multiplexer, sessionId: string): string {
  const dir = shellQuote(remoteDir);
  if (mux === 'tmux') {
    // -A attaches if the session already exists (keep-alive resume).
    return `cd -- ${dir} && exec tmux new-session -A -s ${shellQuote(sessionId)}`;
  }
  if (mux === 'screen') {
    return `cd -- ${dir} && exec screen -D -RR ${shellQuote(sessionId)}`;
  }
  return `cd -- ${dir} && exec $SHELL -l`;
}

function makeSessionId(name: string, remoteDir: string): string {
  const hash = crypto.createHash('sha1').update(`${name}\0${remoteDir}`).digest('hex').slice(0, 10);
  return `tether-${hash}`;
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
