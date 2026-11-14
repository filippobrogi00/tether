import * as vscode from 'vscode';
import { Prompter } from './core/types';

const STASH_KEY = 'tether.handoff';
const LEGACY_STASH_KEY = 'connectLight.handoff';

/**
 * Asks the user for secrets with native VS Code inputs.
 *
 * - Secrets typed during this session are kept in memory so automatic
 *   reconnects never prompt again.
 * - Passwords are only written to the OS keychain (VS Code SecretStorage) if
 *   the user says yes.
 */
export class VscodePrompter implements Prompter {
  private readonly passwords = new Map<string, string>();
  private readonly passphrases = new Map<string, string>();
  private readonly typedNow = new Set<string>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async password(target: string, attempt: number): Promise<string | undefined> {
    if (attempt === 0) {
      const known = this.passwords.get(target) ?? (await this.secrets.get(`password:${target}`));
      if (known !== undefined) return known;
    } else {
      // Whatever we tried before was rejected: forget it everywhere.
      this.passwords.delete(target);
      this.typedNow.delete(target);
      await this.secrets.delete(`password:${target}`);
    }
    const typed = await vscode.window.showInputBox({
      title: `Password for ${target}`,
      prompt: attempt > 0 ? 'That password was not accepted. Try again.' : 'Enter your password for this server.',
      password: true,
      ignoreFocusOut: true,
    });
    if (typed !== undefined) {
      this.passwords.set(target, typed);
      this.typedNow.add(target);
    }
    return typed;
  }

  async passphrase(keyPath: string): Promise<string | undefined> {
    const known = this.passphrases.get(keyPath);
    if (known !== undefined) return known;
    const typed = await vscode.window.showInputBox({
      title: 'SSH key passphrase',
      prompt: `Enter the passphrase for ${keyPath}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (typed !== undefined) this.passphrases.set(keyPath, typed);
    return typed;
  }

  async keyboardInteractive(
    target: string,
    instructions: string,
    prompts: { prompt: string; echo: boolean }[],
  ): Promise<string[] | undefined> {
    const answers: string[] = [];
    for (const p of prompts) {
      const answer = await vscode.window.showInputBox({
        title: `${target} asks`,
        prompt: [instructions, p.prompt].filter(Boolean).join(' '),
        password: !p.echo,
        ignoreFocusOut: true,
      });
      if (answer === undefined) return undefined;
      answers.push(answer);
    }
    return answers;
  }

  async confirmHostKey(target: string, keyType: string, fingerprint: string): Promise<boolean> {
    const trust = 'Trust and Connect';
    const picked = await vscode.window.showWarningMessage(
      `First time connecting to ${target}`,
      {
        modal: true,
        detail:
          `This server identifies itself with the ${keyType} key fingerprint:\n\n${fingerprint}\n\n` +
          `If your server administrator gave you a fingerprint, check that it matches. ` +
          `Tether will remember it and warn you if it ever changes.`,
      },
      trust,
    );
    return picked === trust;
  }

  /** After a successful connect: offer to remember any password typed by hand. */
  async offerToSave(): Promise<void> {
    for (const target of [...this.typedNow]) {
      this.typedNow.delete(target);
      const password = this.passwords.get(target);
      if (password === undefined) continue;
      void vscode.window
        .showInformationMessage(`Remember the password for ${target} in your system keychain?`, 'Remember', 'Not Now')
        .then((choice) => {
          if (choice === 'Remember') void this.secrets.store(`password:${target}`, password);
        });
    }
  }

  /**
   * A prompter for background reconnects: answers only from what is already
   * known and never opens a dialog. Unknown answers cancel the attempt.
   */
  quiet(): Prompter {
    return {
      password: async (target, attempt) =>
        attempt === 0 ? (this.passwords.get(target) ?? (await this.secrets.get(`password:${target}`))) : undefined,
      passphrase: async (keyPath) => this.passphrases.get(keyPath),
      keyboardInteractive: async () => undefined,
      confirmHostKey: async () => false,
    };
  }

  /**
   * Opening a folder reloads the window and with it this extension. Park this
   * session's secrets in the keychain so the user is not asked twice in a row.
   */
  async stashForReload(): Promise<void> {
    if (this.passwords.size === 0 && this.passphrases.size === 0) return;
    await this.secrets.store(
      STASH_KEY,
      JSON.stringify({ at: Date.now(), passwords: [...this.passwords], passphrases: [...this.passphrases] }),
    );
  }

  async restoreStash(): Promise<void> {
    const raw = (await this.secrets.get(STASH_KEY)) ?? (await this.secrets.get(LEGACY_STASH_KEY));
    if (!raw) return;
    await this.secrets.delete(STASH_KEY);
    await this.secrets.delete(LEGACY_STASH_KEY);
    try {
      const data = JSON.parse(raw) as { at: number; passwords: [string, string][]; passphrases: [string, string][] };
      if (Date.now() - data.at > 2 * 60_000) return; // stale hand-off: ignore
      for (const [k, v] of data.passwords) this.passwords.set(k, v);
      for (const [k, v] of data.passphrases) this.passphrases.set(k, v);
    } catch {
      /* ignore a corrupt stash */
    }
  }
}
