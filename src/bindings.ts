import * as path from 'path';
import * as vscode from 'vscode';

/** One remote folder paired with the local workspace folder. */
export type RemoteRef = {
  /** Alias from ~/.ssh/config, or user@host[:port]. */
  target: string;
  /** Folder on the server; may start with ~. */
  remoteDir: string;
};

/** "This local folder mirrors that folder on that server" (plus optional extras). */
export interface Binding {
  /** Alias from ~/.ssh/config, or user@host[:port]. Primary remote. */
  target: string;
  /** Folder on the server; may start with ~. Primary remote. */
  remoteDir: string;
  /**
   * Additional remotes (#2..N). Local is the hub: each remote syncs with local.
   * Absent or empty on bindings saved before multi-remote support.
   */
  extraRemotes?: RemoteRef[];
  /**
   * When true (default), reopening this folder reconnects and syncs again.
   * Cleared by Disconnect; set again on a successful connect / Reconnect.
   * Closing the editor does not clear it — sync stops on shutdown, then resumes on open.
   */
  resumeOnOpen?: boolean;
  /**
   * Top-level names left unchecked in Connect Folder.
   * Applies only at the root of this folder, not to a nested directory with the same name.
   */
  rootExclude?: string[];
  /**
   * Top-level names checked in Connect Folder even though an ignore rule would skip them.
   * That folder is synced in full (except `.git` and transfer temp files).
   */
  rootInclude?: string[];
}

/** Every remote for this binding, primary first. Single-remote bindings yield one entry. */
export function allRemotes(binding: Binding): RemoteRef[] {
  return [{ target: binding.target, remoteDir: binding.remoteDir }, ...(binding.extraRemotes ?? [])];
}

/** Build a binding from an ordered list of remotes (at least one). */
export function bindingFromRemotes(remotes: RemoteRef[], base?: Partial<Binding>): Binding {
  if (remotes.length === 0) throw new Error('At least one remote is required');
  const binding: Binding = {
    ...base,
    target: remotes[0].target,
    remoteDir: remotes[0].remoteDir,
  };
  if (remotes.length > 1) binding.extraRemotes = remotes.slice(1);
  else delete binding.extraRemotes;
  return binding;
}

/** Short label for status / menus: `host` or `host +N`. */
export function bindingLabel(binding: Binding): string {
  const remotes = allRemotes(binding);
  if (remotes.length === 1) return remotes[0].target;
  return `${remotes[0].target} +${remotes.length - 1}`;
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
    const targets = allRemotes(binding).map((r) => r.target);
    const recent = [...targets, ...this.recentTargets().filter((t) => !targets.includes(t))].slice(0, 8);
    await this.state.update(RECENT, recent);
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
