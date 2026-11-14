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
const LEGACY_BINDINGS = 'connectLight.bindings';
const LEGACY_RECENT = 'connectLight.recentTargets';

/**
 * Bindings live in VS Code's own storage, not in a config file inside the
 * project, so there is nothing to write by hand and nothing to leak into git.
 */
export class Bindings {
  private migrated = false;

  constructor(private readonly state: vscode.Memento) {}

  private key(folder: string): string {
    const normal = path.normalize(folder).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normal.toLowerCase() : normal;
  }

  /** One-time copy from Connect Light storage keys into Tether keys. */
  async migrateIfNeeded(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;
    const current = this.state.get<Record<string, Binding>>(BINDINGS);
    if (!current || Object.keys(current).length === 0) {
      const legacy = this.state.get<Record<string, Binding>>(LEGACY_BINDINGS, {});
      if (Object.keys(legacy).length) await this.state.update(BINDINGS, legacy);
    }
    const recent = this.state.get<string[]>(RECENT);
    if (!recent?.length) {
      const legacyRecent = this.state.get<string[]>(LEGACY_RECENT, []);
      if (legacyRecent.length) await this.state.update(RECENT, legacyRecent);
    }
  }

  private all(): Record<string, Binding> {
    const cur = this.state.get<Record<string, Binding>>(BINDINGS, {});
    if (Object.keys(cur).length) return cur;
    return this.state.get<Record<string, Binding>>(LEGACY_BINDINGS, {});
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
    const cur = this.state.get<string[]>(RECENT, []);
    if (cur.length) return cur;
    return this.state.get<string[]>(LEGACY_RECENT, []);
  }
}
