import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DB } from '../db.js';
import type { EklavyaConfig, NotificationSink } from '../config.js';
import { nowIso } from '../time.js';
import { DEFAULT_PRIVACY, redact } from './privacy.js';

/**
 * Outbound wrap-ups (PRD EXT-01, SEC-02).
 *
 * Three rules, and each is here because the failure it prevents is
 * irreversible. A notification cannot be recalled: once a session summary is in
 * a team channel, deleting the local database changes nothing.
 *
 * 1. **Off unless configured.** No sink, no traffic, and an upgrade never adds
 *    one (CFG-02).
 * 2. **Redact before send, not before display.** Every payload goes through the
 *    same filter capture uses, because the sink is the last boundary.
 * 3. **Deliver once.** Delivery is recorded before the attempt and keyed by the
 *    event's own identity, so a retried hook, a resumed session or a second
 *    worker cannot send the same wrap-up twice.
 */

export interface NotificationEvent {
  /** Stable across retries. Two hooks producing the same event must agree on it. */
  id: string;
  kind: string;
  project: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface DeliveryResult {
  sink: string;
  ok: boolean;
  detail?: string;
}

const DELIVERED_PREFIX = 'notified:';
const TIMEOUT_MS = 4000;

function alreadySent(db: DB, id: string): boolean {
  try {
    const row = db.prepare('SELECT 1 AS hit FROM meta WHERE key = ?').get(`${DELIVERED_PREFIX}${id}`) as
      | { hit: number }
      | undefined;
    return Boolean(row);
  } catch {
    // A database that cannot answer "have I sent this" must not be taken as
    // "no". Sending twice is the worse of the two mistakes here.
    return true;
  }
}

function markSent(db: DB, id: string, note: string): void {
  try {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(`${DELIVERED_PREFIX}${id}`, `${nowIso()}|${note}`);
  } catch {
    /* A recorded delivery that failed to record is a possible duplicate, not a lost session. */
  }
}

function wants(sink: NotificationSink, kind: string): boolean {
  return !sink.events || sink.events.length === 0 || sink.events.includes(kind);
}

/**
 * Sends one event to every configured sink that wants it.
 *
 * Marks delivery *before* attempting it. A sink that fails is a missed
 * notification; a sink that succeeded and was not recorded is a duplicate on
 * every later run, and the second is the one people notice.
 */
export async function notify(
  db: DB,
  config: EklavyaConfig,
  event: NotificationEvent,
): Promise<DeliveryResult[]> {
  if (!config.notifications.enabled) return [];
  const sinks = config.notifications.sinks.filter((s) => wants(s, event.kind));
  if (!sinks.length) return [];
  if (alreadySent(db, event.id)) return [];

  const policy = {
    ...DEFAULT_PRIVACY,
    excludePaths: [...DEFAULT_PRIVACY.excludePaths, ...config.privacy.exclude_paths],
    redactPatterns: config.privacy.redact_patterns,
  };
  const payload = {
    id: event.id,
    kind: event.kind,
    project: event.project,
    at: nowIso(),
    title: redact(event.title, policy).text,
    body: redact(event.body, policy).text,
    data: event.data ?? {},
  };

  markSent(db, event.id, sinks.map((s) => s.kind).join(','));

  const results = await Promise.all(sinks.map((sink) => deliver(sink, payload)));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    markSent(db, event.id, `failed:${failed.map((f) => f.detail ?? f.sink).join(';').slice(0, 120)}`);
  }
  return results;
}

async function deliver(sink: NotificationSink, payload: unknown): Promise<DeliveryResult> {
  try {
    switch (sink.kind) {
      case 'webhook':
        return await postWebhook(sink.target, payload);
      case 'command':
        return await runCommand(sink.target, sink.args ?? [], payload);
      case 'file':
        fs.mkdirSync(path.dirname(sink.target), { recursive: true });
        fs.appendFileSync(sink.target, `${JSON.stringify(payload)}\n`, 'utf8');
        return { sink: 'file', ok: true };
    }
  } catch (error) {
    return { sink: sink.kind, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function postWebhook(url: string, payload: unknown): Promise<DeliveryResult> {
  const controller = new AbortController();
  // Bounded: a wrap-up is never worth making a developer wait on a dead host.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok
      ? { sink: 'webhook', ok: true }
      : { sink: 'webhook', ok: false, detail: `HTTP ${response.status}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The interesting integrations are all somebody's script — a desktop
 * notification, a line in a journal, a message posted by a CLI that already
 * holds the credentials — so the payload goes to stdin and the command is
 * whatever they wrote. It is their machine and their command; Eklavya adds no
 * shell, so nothing here is expanded or interpreted on the way.
 */
function runCommand(command: string, args: string[], payload: unknown): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: DeliveryResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ sink: 'command', ok: false, detail: 'timed out' });
      }, TIMEOUT_MS);
      timer.unref?.();
      child.on('error', (error) => {
        clearTimeout(timer);
        done({ sink: 'command', ok: false, detail: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0 ? { sink: 'command', ok: true } : { sink: 'command', ok: false, detail: `exit ${code}` });
      });
      child.stdin.on('error', () => {
        /* A command that closed stdin early is not a failure by itself. */
      });
      child.stdin.end(JSON.stringify(payload));
    } catch (error) {
      done({ sink: 'command', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** The wrap-up a finished session produces, when anything was learned or recorded. */
export function sessionWrapUp(opts: {
  project: string;
  sessionId: string;
  entries: number;
  questions: number;
  passed: number;
}): NotificationEvent {
  return {
    // Keyed on the session, so a Stop hook that fires twice sends once.
    id: `session:${opts.sessionId}`,
    kind: 'session_summary',
    project: opts.project,
    title: `Eklavya: session finished in ${path.basename(opts.project)}`,
    body: `${opts.entries} memory entries recorded. ${opts.passed}/${opts.questions} questions answered correctly.`,
    data: { entries: opts.entries, questions: opts.questions, passed: opts.passed, session: opts.sessionId },
  };
}

/** The one alert worth interrupting for: capture has stopped and will not restart. */
export function queuePausedAlert(opts: {
  project: string;
  errorClass: string;
  failed: number;
}): NotificationEvent {
  return {
    id: `queue-paused:${opts.project}:${opts.errorClass}`,
    kind: 'queue_paused',
    project: opts.project,
    title: 'Eklavya: memory processing is paused',
    body: `The observation queue is paused (${opts.errorClass}). ${opts.failed} job(s) will not retry until it is resolved.`,
    data: { error_class: opts.errorClass, failed: opts.failed },
  };
}
