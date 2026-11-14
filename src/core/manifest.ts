import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from './types';

interface ManifestFile {
  version: 1;
  /** host + remote folder this manifest belongs to; a mismatch means "start fresh". */
  key: string;
  /** path -> [localSize, localMtimeMs, remoteSize, remoteMtimeS, remoteMode] */
  entries: Record<string, [number, number, number, number, number?]>;
}

export function loadManifest(file: string, key: string): Manifest {
  const m: Manifest = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestFile;
    if (data.version !== 1 || data.key !== key) return m;
    for (const [p, [ls, lm, rs, rm, mode]] of Object.entries(data.entries)) {
      m.set(p, { l: { size: ls, mtime: lm }, r: { size: rs, mtime: rm, mode } });
    }
  } catch {
    /* no manifest yet */
  }
  return m;
}

export async function saveManifest(file: string, key: string, manifest: Manifest): Promise<void> {
  const entries: ManifestFile['entries'] = {};
  for (const [p, e] of manifest) entries[p] = [e.l.size, e.l.mtime, e.r.size, e.r.mtime, e.r.mode];
  const data: ManifestFile = { version: 1, key, entries };
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, file);
}
