/**
 * The anonymous usage ping: once a day, a handful of counts and setting values
 * go to Google Analytics 4 over its Measurement Protocol, so the maintainer can
 * see whether Eklavya is installed, kept and useful. `/docs/usage-analytics/`
 * lists every field; `eklavya telemetry show` prints the next ping verbatim.
 *
 * What makes it anonymous is what it is built from, not a promise about it:
 *   - every value is a number, a boolean or one of Eklavya's own enum values
 *     (`focus: concept`), checked by `assertSafe` before anything is sent;
 *   - the only identity is `install_id`, a random UUID made on first use and
 *     kept in `telemetry.json` beside the database — per install, not per
 *     person, and never in `config.json`, which dotfile managers copy;
 *   - nothing is read from a path, a project name, a concept slug, a question,
 *     an answer or a memory entry, except to count rows.
 *
 * Off: `telemetry: false` in the global config, `EKLAVYA_TELEMETRY=0`, or
 * `DO_NOT_TRACK=1`. It also never runs outside an installed runtime (a
 * checkout, a test) or under CI.
 *
 * This file is what hooks load, so it stays light; the payload and the
 * network are `telemetry-send.ts`, loaded only by `eklavya telemetry`.
 *
 * Shaped like `update.ts`: the SessionStart hook calls
 * `startBackgroundTelemetry`, which records today as active and, when a ping is
 * due, starts `eklavya telemetry send --background` detached. The hook never
 * waits and every failure is swallowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { dbPath, eklavyaHome } from './paths.js';
import { loadGlobalConfig } from './config.js';
import { runtimeCli, runtimeVersion } from './update.js';
import type { DB } from './db.js';

/**
 * GA4 property "Eklavya CLI". Not a secret in any useful sense: it ships in
 * the package, so anyone could post events with it. That makes the counts
 * approximate, which is all they are used for. Empty either one to stop sending.
 */
export const MEASUREMENT_ID = 'G-8XP3NZLJXS';
export const API_SECRET = 'c2IKL021RiGv3hS0WtOFtw';

const ACTIVE_DAYS_KEPT = 30;

export interface TelemetryState {
  install_id?: string;
  created_at?: string;
  /** Last ping that GA4 accepted. The throttle and the start of the next window. */
  sent_at?: string;
  /** UTC days a session started on, newest last. */
  active_days?: string[];
}

export function statePath(): string {
  return path.join(eklavyaHome(), 'telemetry.json');
}

export function readState(): TelemetryState {
  try {
    const v = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return v && typeof v === 'object' ? (v as TelemetryState) : {};
  } catch {
    return {};
  }
}

export function writeState(patch: TelemetryState): void {
  try {
    fs.mkdirSync(eklavyaHome(), { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, statePath());
  } catch {
    /* a lost write costs one duplicate or one missed ping */
  }
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const falsy = (v: string | undefined) => v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
const truthy = (v: string | undefined) => v !== undefined && v.trim() !== '' && !falsy(v);

/** Why the ping is off, or null when it is on. One place, so `doctor` and `status` agree with `send`. */
export function disabledReason(): string | null {
  if (falsy(process.env.EKLAVYA_TELEMETRY)) return 'EKLAVYA_TELEMETRY is set';
  if (truthy(process.env.DO_NOT_TRACK)) return 'DO_NOT_TRACK is set';
  try {
    if (!loadGlobalConfig().telemetry) return 'telemetry is false';
  } catch {
    /* an unreadable config keeps the default */
  }
  return null;
}

/** Can this process send at all? Off in CI, in a checkout or test, and until the property exists. */
export function canSend(): boolean {
  return !process.env.CI && !process.env.EKLAVYA_RUNTIME && !!runtimeVersion() && !!MEASUREMENT_ID && !!API_SECRET;
}

export function installId(): string {
  const s = readState();
  if (s.install_id) return s.install_id;
  const id = randomUUID();
  writeState({ install_id: id, created_at: new Date().toISOString() });
  return id;
}

/** Called by SessionStart: record the day, and start a send if one is due. Never throws. */
export function startBackgroundTelemetry(now = Date.now()): void {
  try {
    if (disabledReason()) return;
    const s = readState();
    const day = today(now);
    const days = s.active_days ?? [];
    if (days[days.length - 1] !== day) writeState({ active_days: [...days, day].slice(-ACTIVE_DAYS_KEPT) });
    if (!canSend() || (s.sent_at && today(Date.parse(s.sent_at)) === day)) return;
    const child = spawn(process.execPath, [runtimeCli(), 'telemetry', 'send', '--background'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* retried next session */
  }
}

/**
 * One more use of a named feature today. Names are Eklavya's own identifiers
 * only — callers pass constants, never input. Never throws: a counter must not
 * cost the command it counts.
 */
export function countUse(db: DB, name: string): void {
  try {
    if (disabledReason()) return;
    db.prepare(
      `INSERT INTO usage_counts (day, name, n) VALUES (?, ?, 1)
       ON CONFLICT(day, name) DO UPDATE SET n = n + 1`,
    ).run(today(), name);
  } catch {
    /* an older schema, a busy database: skip the count */
  }
}

/**
 * `countUse` for the CLI, which mostly has no database open: the file as it
 * is, no migrations, no seed. A command must not pay for opening the full
 * store just to be counted.
 */
export function countCommand(name: string): void {
  if (disabledReason()) return;
  let db: DB | undefined;
  try {
    if (!fs.existsSync(dbPath())) return;
    db = new Database(dbPath(), { fileMustExist: true, timeout: 200 });
    countUse(db, name);
  } catch {
    /* uncounted */
  } finally {
    db?.close();
  }
}
