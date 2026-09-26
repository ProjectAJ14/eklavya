import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The built module, not `src/`: `spawnDashboard` starts the `cli.js` beside
// it, which only exists in `dist/` (`pretest` builds it).
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const daemon = (await import(pathToFileURL(path.join(mcpRoot, 'dist', 'dashboard-daemon.js')).href)) as typeof import('../src/dashboard-daemon.js');
const CLI = path.join(mcpRoot, 'dist', 'cli.js');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A process that answers `/api/health` as an Eklavya dashboard of `version` serving `db`. */
function fakeDashboard(port: number, version: string, db: string): Promise<ChildProcess> {
  const src = `require('http').createServer((q, r) => r.end(JSON.stringify({ app: 'eklavya', version: ${JSON.stringify(version)}, pid: process.pid, db: ${JSON.stringify(db)} })))
    .listen(${port}, '127.0.0.1', () => console.log('up'));`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => child.stdout!.once('data', () => resolve(child)));
}

let home: string;
let port: number;
const saved = { ...process.env };
const children: ChildProcess[] = [];

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-daemon-'));
  port = await freePort();
  process.env.EKLAVYA_HOME = home;
  process.env.EKLAVYA_DB = path.join(home, 'knowledge.db');
  process.env.EKLAVYA_DASHBOARD_PORT = String(port);
});

afterEach(async () => {
  await daemon.stopDashboard(port);
  for (const c of children.splice(0)) c.kill();
  process.env = { ...saved };
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the always-on dashboard', () => {
  it('starts one when nothing answers, then leaves it alone', async () => {
    expect((await daemon.probeDashboard(port)).kind).toBe('down');
    expect(await daemon.ensureDashboard()).toBe('started');
    expect(await daemon.waitForDashboard(5000, port)).toBe(true);

    const probe = await daemon.probeDashboard(port);
    expect(probe.kind).toBe('eklavya');
    if (probe.kind !== 'eklavya') return;
    expect(probe.health.version).toBe(daemon.ownVersion());
    expect(fs.realpathSync(probe.health.db)).toBe(fs.realpathSync(process.env.EKLAVYA_DB!));

    expect(await daemon.ensureDashboard()).toBe('running');
    expect(await daemon.stopDashboard(port)).toBe(true);
    expect((await daemon.probeDashboard(port)).kind).toBe('down');
  }, 15_000);

  it('replaces an older Eklavya, and never a newer one', async () => {
    const older = await fakeDashboard(port, '0.0.1', process.env.EKLAVYA_DB!);
    children.push(older);
    const exited = new Promise((r) => older.once('exit', r));
    expect(await daemon.ensureDashboard()).toBe('replaced');
    await exited;
    expect(await daemon.waitForDashboard(5000, port)).toBe(true);
    await daemon.stopDashboard(port);

    children.push(await fakeDashboard(port, '999.0.0', process.env.EKLAVYA_DB!));
    expect(await daemon.ensureDashboard()).toBe('running');
  }, 15_000);

  it("leaves another database's dashboard and a foreign server alone", async () => {
    const other = await fakeDashboard(port, '0.0.1', path.join(home, 'someone-else.db'));
    children.push(other);
    expect(await daemon.ensureDashboard()).toBe('other');
    expect(other.exitCode).toBeNull();
    other.kill();
    await new Promise((r) => other.once('exit', r));

    const foreign = http.createServer((_q, r) => r.end('<html>vite</html>'));
    await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', () => r()));
    try {
      expect(await daemon.ensureDashboard()).toBe('other');
      expect(await daemon.stopDashboard(port)).toBe(false);
    } finally {
      foreign.close();
    }
  }, 15_000);

  it('a second --serve on a taken port exits quietly instead of moving', async () => {
    expect(await daemon.ensureDashboard()).toBe('started');
    expect(await daemon.waitForDashboard(5000, port)).toBe(true);
    const second = spawnSync(process.execPath, [CLI, 'dashboard', '--serve'], { encoding: 'utf8', timeout: 10_000 });
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
  }, 20_000);

  it('status and stop report what is there', async () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, 'dashboard', ...args], { encoding: 'utf8', timeout: 10_000 });
    expect(cli('status').stdout).toMatch(/No dashboard on/);
    expect(await daemon.ensureDashboard()).toBe('started');
    expect(await daemon.waitForDashboard(5000, port)).toBe(true);
    expect(cli('status').stdout).toMatch(new RegExp(`on http://127.0.0.1:${port} · ${daemon.ownVersion().replace(/\./g, '\\.')} · pid \\d+`));
    expect(cli('stop').stdout).toMatch(/Stopped the dashboard/);
    expect(cli('stop').stdout).toMatch(/No Eklavya dashboard was running/);
  }, 20_000);

  it('SessionStart starts it outside a test run, and never inside one', async () => {
    const hook = path.join(mcpRoot, 'dist', 'hooks', 'session-start.js');
    const input = JSON.stringify({ session_id: 'daemon-test', cwd: home, hook_event_name: 'SessionStart', source: 'startup' });
    const start = (env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env } });

    // A database, so the greeting runs; a first session without one starts the dashboard but says nothing.
    const { openDb } = (await import(pathToFileURL(path.join(mcpRoot, 'dist', 'db.js')).href)) as typeof import('../src/db.js');
    openDb(process.env.EKLAVYA_DB).close();

    expect(start({}).status).toBe(0);
    expect((await daemon.probeDashboard(port)).kind).toBe('down');

    const res = start({ VITEST: '', CI: '' });
    expect(res.status).toBe(0);
    expect(await daemon.waitForDashboard(5000, port)).toBe(true);
    expect(res.stdout).toContain(`Dashboard http://127.0.0.1:${port} started in the background`);
  }, 20_000);
});
