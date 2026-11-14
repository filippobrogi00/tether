import * as path from 'path';
import * as vscode from 'vscode';

/** "This local folder mirrors that folder on that server." */
export interface Binding {
  /** Alias from ~/.ssh/config, or user@host[:port]. */
  target: string;
  /** Folder on the server; may start with ~. */
  remoteDir: string;
  /**
   * When true (default), reopening this folder reconnects and syncs again.
   * Cleared by Disconnect; set again on a successful connect / Reconnect.
   * Closing the editor does not clear it — sync stops on shutdown, then resumes on open.
   */
  resumeOnOpen?: boolean;
}

const BINDINGS = 'tether.bindings';
const RECENT = 'tether.recentTargets';

/**
 * Bindings live in VS Code's own storage, not in a config file inside the
 * project, so there is nothing to write by hand and nothing to leak into git.
 */
export class Bindings {
  constructor(private readonly state: vscode.Memento) {}

  private key(folder: string): string {
    const normal = path.normalize(folder).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normal.toLowerCase() : normal;
  }

  private all(): Record<string, Binding> {
    return this.state.get<Record<string, Binding>>(BINDINGS, {});
  }

  get(folder: string): Binding | undefined {
    return this.all()[this.key(folder)];
  }

  async set(folder: string, binding: Binding): Promise<void> {
    await this.state.update(BINDINGS, { ...this.all(), [this.key(folder)]: binding });
    await this.state.update(RECENT, [binding.target, ...this.recentTargets().filter((t) => t !== binding.target)].slice(0, 8));
  }

  async delete(folder: string): Promise<void> {
    const all = { ...this.all() };
    delete all[this.key(folder)];
    await this.state.update(BINDINGS, all);
  }

  recentTargets(): string[] {
    return this.state.get<string[]>(RECENT, []);
  }
}
