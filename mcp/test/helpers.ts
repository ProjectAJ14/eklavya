import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway DB path under the OS temp dir — never the learner's real data. */
export function tempDbPath(label = 'eklavya'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return path.join(dir, 'knowledge.db');
}

export function cleanup(dbFile: string): void {
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
}
