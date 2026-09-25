import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type ResolvedConfig } from '../src/config.js';
import { appendEvent, batchSession, claimJob, failJob } from '../src/memory/store.js';
import { eventUid } from '../src/memory/identity.js';
import {
  markProbe,
  probeDue,
  PROBE_INTERVAL_MS,
  processPending,
  QUOTA_COOLDOWN_MS,
  queueDepth,
  resumeIfRepaired,
  standInWhilePaused,
} from '../src/memory/worker.js';
import { resumePaused } from '../src/memory/store.js';
import { memoryHealthLine, BEHIND_AFTER_MS } from '../src/hooks/memory-lib.js';
import { record } from '../src/hooks/capture-lib.js';
import { probeLogin, ProviderError, runClaude } from '../src/memory/provider.js';
import { GLOBAL_PROJECT } from '../src/store.js';

const PROJECT = '/tmp/demo-repo';

let dbFile: string;
let db: DB;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-pause');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
});

/** One queued batch, claimed and failed with `errorClass`. */
function pausedJob(errorClass: 'auth' | 'quota' | 'missing', sid = 's1'): number {
  appendEvent(db, {
    eventUid: eventUid({ host: 'claude-code', sessionId: sid, kind: 'prompt', occurredAt: sid, body: sid }),
    project: PROJECT,
    sessionId: sid,
    kind: 'prompt',
    body: `work in ${sid}`,
  });
  batchSession(db, { project: PROJECT, sessionId: sid, reason: 'manual' });
  const job = claimJob(db, 'w')!;
  failJob(db, job.id, 'w', errorClass, 'Not logged in · Please run /login');
  return job.id;
}

describe('resuming a paused queue once its cause is fixed', () => {
  it('resumes an auth pause when the login check says logged in', async () => {
    pausedJob('auth');
    expect(await resumeIfRepaired(db, async () => 'ok')).toBe(1);
    expect(queueDepth(db)).toMatchObject({ paused: 0, pending: 1 });
  });

  it('leaves it paused, unspent, while the login is still missing or the check is unsure', async () => {
    pausedJob('auth');
    for (const answer of ['auth', 'missing', 'unknown'] as const) {
      expect(await resumeIfRepaired(db, async () => answer)).toBe(0);
    }
    expect(queueDepth(db).paused).toBe(1);
  });

  it('waits out a usage limit without a check, then lets one job try again', async () => {
    pausedJob('quota');
    let probed = false;
    const probe = async () => {
      probed = true;
      return 'ok' as const;
    };
    expect(await resumeIfRepaired(db, probe, Date.now())).toBe(0);
    expect(await resumeIfRepaired(db, probe, Date.now() + QUOTA_COOLDOWN_MS + 1_000)).toBe(1);
    // A quota has no free check; the cooldown is the whole condition.
    expect(probed).toBe(false);
  });

  it('does nothing when nothing is paused', async () => {
    expect(await resumeIfRepaired(db, async () => 'ok')).toBe(0);
  });

  it('lets one seam in an interval launch the check', () => {
    const now = Date.now();
    expect(probeDue(db, now)).toBe(true);
    markProbe(db, now);
    expect(probeDue(db, now + 60_000)).toBe(false);
    expect(probeDue(db, now + PROBE_INTERVAL_MS)).toBe(true);
  });
});

const live = (generator?: string) =>
  (db
    .prepare(`SELECT count(*) n FROM memory_entries WHERE deleted_at IS NULL${generator ? ' AND generator = ?' : ''}`)
    .get(...(generator ? [generator] : [])) as { n: number }).n;

describe('local stand-ins while the provider is paused', () => {
  it('writes local entries for waiting batches once, and leaves the jobs queued', async () => {
    pausedJob('auth', 's1');
    appendEvent(db, { eventUid: 'later', project: PROJECT, sessionId: 's2', kind: 'prompt', body: 'Add refresh token rotation' });
    batchSession(db, { project: PROJECT, sessionId: 's2', reason: 'manual' });

    expect(await standInWhilePaused(db)).toBe(2);
    expect(live('local-v1')).toBe(2);
    expect(queueDepth(db)).toMatchObject({ paused: 1, pending: 1 });
    // Stood in once: the next seam does not re-read the same batches.
    expect(await standInWhilePaused(db)).toBe(0);
    expect(live('local-v1')).toBe(2);
  });
});

describe('the banner line for memory that stopped keeping up', () => {
  it('says nothing for a healthy queue', () => {
    expect(memoryHealthLine(db)).toBeNull();
  });

  it('names a pause, its cause and the fix', () => {
    pausedJob('auth');
    expect(memoryHealthLine(db)).toMatch(/^Memory paused · claude not logged in since \d+ \w{3} · local summaries meanwhile · fix it, then: eklavya memory process$/);
  });

  it('warns once the oldest waiting job is older than a working worker would leave it', () => {
    appendEvent(db, {
      eventUid: 'e1',
      project: PROJECT,
      sessionId: 's1',
      kind: 'prompt',
      body: 'work',
    });
    batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'manual' });
    const now = Date.now();
    expect(memoryHealthLine(db, now)).toBeNull();
    expect(memoryHealthLine(db, now + BEHIND_AFTER_MS + 3_600_000)).toMatch(/^Memory behind · 1 job waiting, oldest [67]h · run: eklavya doctor$/);
  });
});

describe('capture outside a git checkout', () => {
  it('records nothing when only this project is searched', () => {
    const resolved = { config: structuredClone(DEFAULT_CONFIG) } as ResolvedConfig;
    const identity = { project: GLOBAL_PROJECT, checkout: null, sessionId: 's1', agentId: null, host: 'claude-code' };
    expect(record(db, resolved, identity, { kind: 'prompt', title: 'prompt', body: 'hello' })).toBe(false);
    expect((db.prepare('SELECT count(*) n FROM evidence_events').get() as { n: number }).n).toBe(0);

    const inRepo = { ...identity, project: PROJECT, checkout: PROJECT };
    expect(record(db, resolved, inRepo, { kind: 'prompt', title: 'prompt', body: 'hello' })).toBe(true);
  });

  it('records it when cross-project search can serve it', () => {
    const resolved = { config: structuredClone(DEFAULT_CONFIG) } as ResolvedConfig;
    resolved.config.retrieval.cross_project = true;
    const identity = { project: GLOBAL_PROJECT, checkout: null, sessionId: 's1', agentId: null, host: 'claude-code' };
    expect(record(db, resolved, identity, { kind: 'prompt', title: 'prompt', body: 'hello' })).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('the claude process, stubbed', () => {
  const origPath = process.env.PATH;
  let bin: string;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-claude-'));
    process.env.PATH = `${bin}${path.delimiter}${origPath}`;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const stub = (script: string) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

  it('keeps what a run printed on stderr when it printed no JSON, and classifies it', async () => {
    stub("cat >/dev/null\necho 'Not logged in · Please run /login' >&2\nexit 1");
    const err = (await runClaude('m', 'x', { graceMs: 100 }).catch((e: unknown) => e)) as ProviderError;
    expect(err.errorClass).toBe('auth');
    expect(err.message).toContain('Not logged in');
  });

  it('replaces the stand-in with the provider summary once the batch is summarised', async () => {
    pausedJob('auth');
    await standInWhilePaused(db);
    expect(live('local-v1')).toBe(1);
    stub(
      `cat >/dev/null\necho '${JSON.stringify({
        subtype: 'success',
        is_error: false,
        structured_output: { observations: [{ title: 'Real summary', type: 'change', narrative: 'n', facts: [], files: [], tags: [] }] },
      })}'`,
    );
    resumePaused(db);
    const config = structuredClone(DEFAULT_CONFIG);
    config.providers.observer = { kind: 'anthropic', model: 'm' };
    const result = await processPending(db, config, { maxJobs: 1 });
    expect(result.entries).toBe(1);
    expect(live('local-v1')).toBe(0);
    expect(live()).toBe(1);
  });

  it('reads the login state from claude auth status', async () => {
    stub('echo \'{"loggedIn": true, "authMethod": "claude.ai"}\'');
    expect(await probeLogin()).toBe('ok');
    stub('echo \'{"loggedIn": false}\'');
    expect(await probeLogin()).toBe('auth');
    stub('echo not json');
    expect(await probeLogin()).toBe('unknown');
  });
});
