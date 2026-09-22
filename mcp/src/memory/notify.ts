import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DB } from '../db.js';
import type { EklavyaConfig, NotificationSink } from '../config.js';
import { nowIso, parseStamp } from '../time.js';
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
 * 3. **Deliver once, but do deliver.** The ledger is keyed by the event's
 *    identity *and the sink's*, so a retried hook, a resumed session or a
 *    second worker cannot send the same wrap-up twice down the same pipe —
 *    while a sink that was down still gets it on a later pass, and a sibling
 *    sink that already accepted it does not get it again.
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
/** Retries are for a sink that is briefly down, not for one that is gone. */
const MAX_ATTEMPTS = 3;
/** A wrap-up or a paused-queue alert from yesterday is noise, not news. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One row per (event, sink). `n` counts attempts *started*, not ones that reported back. */
interface DeliveryState {
  ok: boolean;
  n: number;
  first: string;
  detail?: string;
}

function ledgerKey(eventId: string, sink: NotificationSink): string {
  // The target is hashed, not stored: a webhook URL is frequently the whole
  // credential, and a delivery ledger is not a place to keep one.
  const fingerprint = createHash('sha256').update(`${sink.kind}\u0000${sink.target}`).digest('hex').slice(0, 16);
  return `${DELIVERED_PREFIX}${eventId}:${fingerprint}`;
}

/** `null` means nothing has been tried yet. */
function readState(db: DB, key: string): DeliveryState | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as DeliveryState) : null;
  } catch {
    // A database that cannot answer "have I sent this" — or a row that no
    // longer parses — must not be taken as "no". Sending twice is the worse of
    // the two mistakes, so report a state that is already spent.
    return { ok: true, n: MAX_ATTEMPTS, first: nowIso() };
  }
}

function writeState(db: DB, key: string, state: DeliveryState): void {
  try {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(state));
  } catch {
    /* A recorded delivery that failed to record is a possible duplicate, not a lost session. */
  }
}

function retriable(state: DeliveryState | null, now: number): boolean {
  if (!state) return true;
  if (state.ok || state.n >= MAX_ATTEMPTS) return false;
  const first = parseStamp(state.first);
  // An unparseable stamp stops the retries rather than granting them forever.
  return first !== null && now - first < MAX_AGE_MS;
}

/**
 * Rows this version does not write, left by a version that keyed the whole
 * event rather than each sink. Treated as delivered so an upgrade does not
 * re-send every alert whose id is still live.
 *
 * ponytail: never cleaned up. These are a handful of `meta` rows that stop
 * mattering once their events age out; a migration to drop them is not worth
 * the forward-only schema bump.
 */
function sentBeforeUpgrade(db: DB, id: string): boolean {
  try {
    return Boolean(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`${DELIVERED_PREFIX}${id}`));
  } catch {
    return true;
  }
}

function wants(sink: NotificationSink, kind: string): boolean {
  return !sink.events || sink.events.length === 0 || sink.events.includes(kind);
}

/**
 * Sends one event to every configured sink that wants it and has not already
 * taken it.
 *
 * The attempt is written *before* the send and only flipped to `ok` after the
 * sink accepted. Recording first is what stops a crash between the send and the
 * write from resending for ever, which is why the ordering was chosen; the flag
 * is what stops a sink that was down for thirty seconds from losing the
 * notification permanently. A crash in that window costs a duplicate, bounded
 * by MAX_ATTEMPTS — the one outcome neither ordering can rule out.
 */
export async function notify(
  db: DB,
  config: EklavyaConfig,
  event: NotificationEvent,
): Promise<DeliveryResult[]> {
  if (!config.notifications.enabled) return [];
  const wanted = config.notifications.sinks.filter((s) => wants(s, event.kind));
  if (!wanted.length) return [];
  if (sentBeforeUpgrade(db, event.id)) return [];

  const now = Date.now();
  const pending = wanted
    .map((sink) => {
      const key = ledgerKey(event.id, sink);
      return { sink, key, state: readState(db, key) };
    })
    .filter((p) => retriable(p.state, now));
  if (!pending.length) return [];

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

  return await Promise.all(
    pending.map(async ({ sink, key, state }) => {
      const attempt: DeliveryState = { ok: false, n: (state?.n ?? 0) + 1, first: state?.first ?? nowIso() };
      writeState(db, key, attempt);
      const result = await deliver(sink, payload);
      writeState(db, key, { ...attempt, ok: result.ok, detail: result.detail?.slice(0, 120) });
      return result;
    }),
  );
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
