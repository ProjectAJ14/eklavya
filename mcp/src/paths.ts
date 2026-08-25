import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Eklavya keeps all state in one directory so it is trivially inspectable and
 * deletable. `EKLAVYA_HOME` exists so tests never touch the real learner's data.
 */
export function eklavyaHome(): string {
  return process.env.EKLAVYA_HOME ?? path.join(os.homedir(), '.eklavya');
}

export function dbPath(): string {
  return process.env.EKLAVYA_DB ?? path.join(eklavyaHome(), 'knowledge.db');
}

export function globalConfigPath(): string {
  return path.join(eklavyaHome(), 'config.json');
}

/** Directory of this module — `src/` under tsx, `dist/` after a build. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  return path.join(moduleDir, 'migrations');
}

export function seedDir(): string {
  return path.join(moduleDir, 'seed');
}
