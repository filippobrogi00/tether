import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sshDir } from './sshConfig';

export type HostKeyStatus = 'trusted' | 'unknown' | 'changed';

/**
 * Host key checking.
 *
 * Reads the user's existing ~/.ssh/known_hosts (so hosts already trusted in a
 * terminal are trusted here), and keeps newly accepted keys in its own JSON file
 * instead of editing the user's SSH files.
 */
export class KnownHosts {
  private own: Record<string, string[]> = {};

  constructor(private readonly storeFile?: string) {
    if (storeFile) {
      try {
        this.own = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      } catch {
        this.own = {};
      }
    }
  }

  static fingerprint(key: Buffer): string {
    return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  }

  /** Key type name is the first length-prefixed string in the key blob. */
  static keyType(key: Buffer): string {
    const len = key.readUInt32BE(0);
    return key.subarray(4, 4 + len).toString('ascii');
  }

  check(host: string, port: number, key: Buffer): HostKeyStatus {
    const b64 = key.toString('base64');
    const type = KnownHosts.keyType(key);
    const id = `${host}:${port}`;

    const ownKeys = this.own[id] ?? [];
    if (ownKeys.includes(b64)) return 'trusted';

    let sameTypeSeen = ownKeys.some((k) => KnownHosts.keyType(Buffer.from(k, 'base64')) === type);
    for (const entry of this.systemEntries(host, port)) {
      if (entry.key === b64) return 'trusted';
      if (entry.type === type) sameTypeSeen = true;
    }
    return sameTypeSeen ? 'changed' : 'unknown';
  }

  trust(host: string, port: number, key: Buffer): void {
    const id = `${host}:${port}`;
    const b64 = key.toString('base64');
    this.own[id] = [...new Set([...(this.own[id] ?? []), b64])];
    if (!this.storeFile) return;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      fs.writeFileSync(this.storeFile, JSON.stringify(this.own, null, 2));
    } catch {
      /* trust still holds for this session */
    }
  }

  private *systemEntries(host: string, port: number): Generator<{ type: string; key: string }> {
    const names = port === 22 ? [host] : [`[${host}]:${port}`];
    for (const file of ['known_hosts', 'known_hosts2']) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(sshDir(), file), 'utf8');
      } catch {
        continue;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('@')) continue;
        const [hosts, type, key] = line.split(/\s+/);
        if (!hosts || !type || !key) continue;
        if (names.some((n) => matchesHostField(hosts, n))) yield { type, key };
      }
    }
  }
}

function matchesHostField(field: string, name: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const mac = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return mac === hash;
  }
  return field.split(',').some((pattern) => {
    if (pattern.startsWith('!')) return false;
    if (!/[*?]/.test(pattern)) return pattern === name;
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return re.test(name);
  });
}
