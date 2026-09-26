/**
 * The always-on dashboard: one `eklavya dashboard --serve` per machine, started
 * detached by SessionStart when nothing answers the port, and replaced when an
 * older Eklavya is the one answering. Nothing supervises it; the next session
 * start is the restart, which is how a crash, a reboot or an update recovers.
 *
 * The port is the lock. Two sessions starting together can both spawn, and the
 * one that loses the bind exits quietly (`--serve` never falls back to another
 * port). `/api/health` names the process, so a stop only ever signals a pid an
 * Eklavya dashboard just reported for itself, never one read from a stale file.
 *
 * Deliberately light on imports: the SessionStart hook loads this on every
 * session, and it must not drag in the dashboard, the database or zod.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dashboardLogPath, dashboardPort, dbPath, eklavyaHome } from './paths.js';
import { compareVersions } from './update.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** This build's version: the package this module shipped in. */
export function ownVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(moduleDir, '..', 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}

/** What `/api/health` answers. `db` is the database that process is serving. */
export interface DashboardHealth {
  app: 'eklavya';
  version: string;
  pid: number;
  db: string;
}

export type DashboardProbe =
  | { kind: 'eklavya'; health: DashboardHealth }
  /** Nothing listening: the connection was refused. */
  | { kind: 'down' }
  /** Something answered, or hung, that is not an Eklavya dashboard this build can read. */
  | { kind: 'foreign' };

export function probeDashboard(port = dashboardPort(), timeoutMs = 150): Promise<DashboardProbe> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      res.on('end', () => {
        try {
          const h = JSON.parse(body) as Partial<DashboardHealth>;
          if (h.app === 'eklavya' && typeof h.version === 'string' && Number.isInteger(h.pid) && typeof h.db === 'string') {
            return resolve({ kind: 'eklavya', health: h as DashboardHealth });
          }
        } catch {
          /* not ours */
        }
        resolve({ kind: 'foreign' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED' ? { kind: 'down' } : { kind: 'foreign' }));
  });
}

/** Starts `eklavya dashboard --serve` detached, from this build unless told otherwise. Never throws. */
export function spawnDashboard(cli = path.join(moduleDir, 'cli.js')): boolean {
  try {
    fs.mkdirSync(eklavyaHome(), { recursive: true });
    // Truncated per start: the log only has to explain the latest failure.
    const log = fs.openSync(dashboardLogPath(), 'w');
    const child = spawn(process.execPath, [cli, 'dashboard', '--serve'], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    fs.closeSync(log);
    // An async spawn failure lands after the caller moved on; unheard, it is an uncaught error.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops the Eklavya dashboard on the port, if one answers, and waits up to 2s for the port to free. */
export async function stopDashboard(port = dashboardPort()): Promise<boolean> {
  const probe = await probeDashboard(port, 500);
  if (probe.kind !== 'eklavya') return false;
  try {
    process.kill(probe.health.pid, 'SIGTERM');
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i++) {
    if ((await probeDashboard(port, 100)).kind === 'down') return true;
    await sleep(100);
  }
  return false;
}

/** Waits up to `ms` for an Eklavya dashboard to answer: for a caller about to open it in a browser. */
export async function waitForDashboard(ms = 3000, port = dashboardPort()): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if ((await probeDashboard(port)).kind === 'eklavya') return true;
    await sleep(100);
  }
  return false;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * - `running`: an Eklavya this version or newer already serves this database.
 * - `started` / `replaced`: one was spawned, the second after stopping an older one.
 * - `other`: the port belongs to something else, or to a dashboard on another
 *   database (a different `EKLAVYA_DB`); left alone.
 * - `failed`: a spawn or stop did not happen.
 */
export type EnsureResult = 'running' | 'started' | 'replaced' | 'other' | 'failed';

/**
 * Never downgrades: a checkout and the runtime can be different versions, and
 * replacing only an older one is what keeps the two from replacing each other
 * every session.
 */
export async function ensureDashboard(): Promise<EnsureResult> {
  try {
    const probe = await probeDashboard();
    if (probe.kind === 'down') return spawnDashboard() ? 'started' : 'failed';
    if (probe.kind === 'foreign' || !samePath(probe.health.db, dbPath())) return 'other';
    if (compareVersions(probe.health.version, ownVersion()) >= 0) return 'running';
    return (await stopDashboard()) && spawnDashboard() ? 'replaced' : 'failed';
  } catch {
    return 'failed';
  }
}
