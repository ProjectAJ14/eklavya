import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { deleteEntry, insertEntry, entryTags, timeline } from '../src/memory/store.js';
import {
  conflicts,
  deviceId,
  pull,
  push,
  repairConflict,
  syncStatus,
} from '../src/memory/sync.js';
import { cleanup, tempDbPath } from './helpers.js';

/**
 * Two devices, one shared folder (ADR-09).
 *
 * `laptop` and `desktop` are two real databases with two real device ids, and
 * `shared` is the directory a Dropbox or a Syncthing would be. Nothing here
 * stubs the transport, because the transport is the design: every property
 * worth asserting -- tombstones, quarantine, a torn file, what never crosses --
 * is a question about files on disk.
 */
const PROJECT = '/tmp/shared-repo';

let laptopFile = '';
let desktopFile = '';
let shared = '';
let laptop: DB;
let desktop: DB;

/** Device ids are pinned so a failure names a side rather than a uuid. */
function configFor(device: string, over: Partial<EklavyaConfig['sync']> = {}): EklavyaConfig {
  return {
    ...DEFAULT_CONFIG,
    sync: { enabled: true, target: shared, device_id: device, ...over },
  };
}

// Built in `beforeEach`, not at module load: `shared` does not exist yet.
let LAPTOP: EklavyaConfig;
let DESKTOP: EklavyaConfig;

function note(db: DB, title: string, over: Parameters<typeof insertEntry>[1] | object = {}): number {
  return insertEntry(db, {
    project: PROJECT,
    title,
    narrative: `about ${title}`,
    occurredAt: '2026-09-01T10:00:00.000Z',
    ...(over as object),
  } as Parameters<typeof insertEntry>[1]);
}

function titles(db: DB): string[] {
  return timeline(db, { project: PROJECT })
    .map((e) => e.title)
    .sort();
}

function entryByUid(db: DB, uid: string) {
  return db.prepare('SELECT * FROM memory_entries WHERE entry_uid = ?').get(uid) as
    | { id: number; title: string; narrative: string; deleted_at: string | null }
    | undefined;
}

function uidOf(db: DB, id: number): string {
  return (db.prepare('SELECT entry_uid FROM memory_entries WHERE id = ?').get(id) as {
    entry_uid: string;
  }).entry_uid;
}

beforeEach(() => {
  laptopFile = tempDbPath('eklavya-sync-laptop');
  desktopFile = tempDbPath('eklavya-sync-desktop');
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-sync-target-'));
  laptop = openDb(laptopFile);
  desktop = openDb(desktopFile);
  LAPTOP = configFor('laptop');
  DESKTOP = configFor('desktop');
});

afterEach(() => {
  laptop.close();
  desktop.close();
  cleanup(laptopFile);
  cleanup(desktopFile);
  fs.rmSync(shared, { recursive: true, force: true });
});

describe('device identity', () => {
  it('mints one id per install and keeps it', () => {
    const config = { ...DEFAULT_CONFIG, sync: { enabled: true, target: shared, device_id: null } };
    const first = deviceId(laptop, config);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(deviceId(laptop, config)).toBe(first);
    // A second install is a second device, however identical its config.
    expect(deviceId(desktop, config)).not.toBe(first);
  });

  it('lives in the database, not in the config file that travels between machines', () => {
    deviceId(laptop, { ...DEFAULT_CONFIG, sync: { enabled: true, target: shared, device_id: null } });
    const row = laptop.prepare("SELECT value FROM meta WHERE key = 'sync_device_id'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBeTruthy();
  });
});

describe('push and pull', () => {
  it('carries entries and their tags to the other device', () => {
    note(laptop, 'refresh token rotation', { tags: ['auth', 'Security'], type: 'decision' });
    note(laptop, 'why the gate counts work concepts');

    const pushed = push(laptop, LAPTOP);
    expect(pushed.ok).toBe(true);
    expect(pushed.staged).toBe(2);
    expect(pushed.written).toBe(2);

    const pulled = pull(desktop, DESKTOP);
    expect(pulled.applied).toBe(2);
    expect(pulled.conflicts).toBe(0);
    expect(titles(desktop)).toEqual(['refresh token rotation', 'why the gate counts work concepts']);

    const arrived = entryByUid(desktop, uidOf(laptop, 1))!;
    expect(arrived.narrative).toBe('about refresh token rotation');
    expect(entryTags(desktop, arrived.id)).toEqual(['auth', 'security']);
  });

  it('is a no-op the second time, in both directions', () => {
    note(laptop, 'first');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    const again = pull(desktop, DESKTOP);
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(0);
    expect(again.conflicts).toBe(0);

    // And the receiving device does not re-publish what it was given.
    const rePush = push(desktop, DESKTOP);
    expect(rePush.staged).toBe(0);
    expect(rePush.written).toBe(0);
    expect(titles(desktop)).toEqual(['first']);
  });

  it('resumes an interrupted push without duplicating what already landed', () => {
    note(laptop, 'one');
    note(laptop, 'two');
    push(laptop, LAPTOP);

    // The interruption: one record never reached the folder.
    const dir = path.join(shared, 'devices', 'laptop');
    const lost = fs.readdirSync(dir).sort().at(-1)!;
    fs.rmSync(path.join(dir, lost));

    const resumed = push(laptop, LAPTOP);
    expect(resumed.staged).toBe(0); // nothing changed locally, so no new revisions
    expect(resumed.written).toBe(1); // only the missing record is rewritten
    expect(resumed.already).toBe(1);
    expect(fs.readdirSync(dir).length).toBe(2);

    pull(desktop, DESKTOP);
    expect(titles(desktop)).toEqual(['one', 'two']);
  });
});

describe('tombstones', () => {
  it('propagates a deletion and does not let the other device resurrect it', () => {
    note(laptop, 'keep me');
    const doomed = note(laptop, 'delete me');
    const doomedUid = uidOf(laptop, doomed);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    expect(titles(desktop)).toEqual(['delete me', 'keep me']);

    deleteEntry(laptop, doomed);
    const pushed = push(laptop, LAPTOP);
    expect(pushed.staged).toBe(1);

    const pulled = pull(desktop, DESKTOP);
    expect(pulled.tombstones).toBe(1);
    expect(entryByUid(desktop, doomedUid)!.deleted_at).not.toBeNull();
    expect(titles(desktop)).toEqual(['keep me']);

    // The bug this exists to prevent: the device that still had the entry
    // pushing it straight back on the next round trip.
    const back = push(desktop, DESKTOP);
    expect(back.staged).toBe(0);
    pull(laptop, LAPTOP);
    expect(titles(laptop)).toEqual(['keep me']);
    expect(entryByUid(laptop, doomedUid)!.deleted_at).not.toBeNull();
  });

  it('carries no content in a tombstone, and buries an entry that arrives later', () => {
    const doomed = note(laptop, 'secret title');
    const doomedUid = uidOf(laptop, doomed);
    push(laptop, LAPTOP);
    deleteEntry(laptop, doomed);
    push(laptop, LAPTOP);

    const tombstone = JSON.parse(
      fs.readFileSync(
        path.join(shared, 'devices', 'laptop', fs.readdirSync(path.join(shared, 'devices', 'laptop')).sort().at(-1)!),
        'utf8',
      ),
    ) as { op: string; entry: unknown; entry_uid: string };
    expect(tombstone.op).toBe('delete');
    expect(tombstone.entry).toBeNull();
    expect(tombstone.entry_uid).toBe(doomedUid);

    // A device seeing both records in one pull ends deleted, not undeleted.
    pull(desktop, DESKTOP);
    expect(entryByUid(desktop, doomedUid)!.deleted_at).not.toBeNull();
  });
});

describe('conflicts', () => {
  /** Both devices edit the same entry between syncs. */
  function diverge(): { uid: string; laptopId: number; desktopId: number } {
    const id = note(laptop, 'shared note');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    const desktopId = entryByUid(desktop, uid)!.id;
    laptop.prepare('UPDATE memory_entries SET narrative = ? WHERE id = ?').run('laptop version', id);
    desktop
      .prepare('UPDATE memory_entries SET narrative = ? WHERE id = ?')
      .run('desktop version', desktopId);
    return { uid, laptopId: id, desktopId };
  }

  it('quarantines the incoming version rather than overwriting the local one', () => {
    const { uid, desktopId } = diverge();
    push(laptop, LAPTOP);

    const pulled = pull(desktop, DESKTOP);
    expect(pulled.conflicts).toBe(1);
    expect(pulled.applied).toBe(0);

    // Nothing was overwritten: the local edit is still what the entry says.
    expect(entryByUid(desktop, uid)!.narrative).toBe('desktop version');

    // And the losing version is readable in full, not thrown away.
    const [row] = conflicts(desktop);
    expect(row.entry_uid).toBe(uid);
    expect(row.device_id).toBe('laptop');
    expect(row.resolved_at).toBeNull();
    expect(JSON.parse(row.payload).entry.narrative).toBe('laptop version');
    expect(desktopId).toBeGreaterThan(0);
  });

  it('repairs to the remote side and the choice travels back', () => {
    const { uid } = diverge();
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    expect(repairConflict(desktop, DESKTOP, conflicts(desktop)[0].id, 'remote')).toBe(true);
    expect(entryByUid(desktop, uid)!.narrative).toBe('laptop version');
    expect(conflicts(desktop)).toHaveLength(0);

    // The repair is published as a new revision based on the version the other
    // device holds, so it lands there as an ordinary fast-forward.
    push(desktop, DESKTOP);
    const back = pull(laptop, LAPTOP);
    expect(back.conflicts).toBe(0);
    expect(entryByUid(laptop, uid)!.narrative).toBe('laptop version');
    expect(conflicts(laptop)).toHaveLength(0);
  });

  it('repairs to the local side and the other device accepts it', () => {
    const { uid } = diverge();
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    expect(repairConflict(desktop, DESKTOP, conflicts(desktop)[0].id, 'local')).toBe(true);
    expect(entryByUid(desktop, uid)!.narrative).toBe('desktop version');

    push(desktop, DESKTOP);
    const back = pull(laptop, LAPTOP);
    expect(back.conflicts).toBe(0);
    expect(entryByUid(laptop, uid)!.narrative).toBe('desktop version');
  });
});

describe('offline recovery', () => {
  it('ignores a half-written record rather than applying it', () => {
    note(laptop, 'complete');
    push(laptop, LAPTOP);

    const dir = path.join(shared, 'devices', 'laptop');
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)), 'utf8');

    const pulled = pull(desktop, DESKTOP);
    expect(pulled.applied).toBe(0);
    expect(pulled.stalled).toEqual(['laptop']);
    expect(titles(desktop)).toEqual([]);

    // Stalling, not skipping: once the writer finishes, the record is read.
    fs.writeFileSync(file, whole, 'utf8');
    expect(pull(desktop, DESKTOP).applied).toBe(1);
    expect(titles(desktop)).toEqual(['complete']);
  });

  it('ignores a record whose payload does not match its own hash', () => {
    note(laptop, 'honest');
    push(laptop, LAPTOP);

    const dir = path.join(shared, 'devices', 'laptop');
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.entry.narrative = 'tampered or torn on a record boundary';
    fs.writeFileSync(file, JSON.stringify(rec), 'utf8');

    expect(pull(desktop, DESKTOP).applied).toBe(0);
    expect(titles(desktop)).toEqual([]);
  });

  it('writes records through a temp name, leaving nothing half-written behind', () => {
    note(laptop, 'atomic');
    push(laptop, LAPTOP);
    const names = fs.readdirSync(path.join(shared, 'devices', 'laptop'));
    expect(names).toEqual(['000000000001.json']);
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false);
  });
});

describe('privacy', () => {
  /** Everything SEC-02 says is the developer's own and must not cross. */
  function learningSnapshot(db: DB) {
    const all = (sql: string) => JSON.stringify(db.prepare(sql).all());
    return {
      attempts: all('SELECT * FROM attempts ORDER BY id'),
      mastery: all('SELECT * FROM mastery ORDER BY concept_id'),
      gates: all('SELECT * FROM gates ORDER BY session_id'),
      session_concepts: all('SELECT * FROM session_concepts ORDER BY session_id, concept_id'),
      receipts: all('SELECT * FROM context_receipts ORDER BY id'),
      receipt_items: all('SELECT * FROM context_receipt_items ORDER BY receipt_id, entry_id'),
      evidence: all('SELECT * FROM evidence_events ORDER BY id'),
    };
  }

  function giveLearningHistory(db: DB, tag: string): void {
    db.prepare(
      "INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty) VALUES (1, ?, ?, 'an answer', 5, 1)",
    ).run(`session-${tag}`, `what does ${tag} know?`);
    db.prepare('INSERT INTO mastery (concept_id, score, reps) VALUES (1, 0.9, 3)').run();
    db.prepare("INSERT INTO gates (session_id, mode, required, answered, passed) VALUES (?, 'enforced', 4, 4, 1)").run(
      `session-${tag}`,
    );
    db.prepare(
      "INSERT INTO context_receipts (receipt_uid, project, scope, method, base_tokens, delivered_tokens) VALUES (?, ?, 'session_start', 'estimate', 900, 200)",
    ).run(`receipt-${tag}`, PROJECT);
    db.prepare(
      `INSERT INTO evidence_events (event_uid, project, session_id, kind, body, occurred_at)
       VALUES (?, ?, ?, 'prompt', ?, '2026-09-01T09:00:00.000Z')`,
    ).run(`event-${tag}`, PROJECT, `session-${tag}`, `${tag} typed something private`);
  }

  it('leaves attempts, mastery, gates, receipts and evidence untouched on both sides', () => {
    giveLearningHistory(laptop, 'laptop');
    giveLearningHistory(desktop, 'desktop');
    note(laptop, 'an observation worth sharing', { tags: ['sync'] });
    note(desktop, 'something the desktop learned');

    const before = { laptop: learningSnapshot(laptop), desktop: learningSnapshot(desktop) };

    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    push(desktop, DESKTOP);
    pull(laptop, LAPTOP);

    // The memory half did cross, so this is not a test of sync doing nothing.
    expect(titles(laptop)).toEqual(['an observation worth sharing', 'something the desktop learned']);
    expect(titles(desktop)).toEqual(['an observation worth sharing', 'something the desktop learned']);

    expect(learningSnapshot(laptop)).toEqual(before.laptop);
    expect(learningSnapshot(desktop)).toEqual(before.desktop);
  });

  it('writes nothing about a learner into the shared folder', () => {
    giveLearningHistory(laptop, 'laptop');
    note(laptop, 'an observation worth sharing');
    push(laptop, LAPTOP);

    const dir = path.join(shared, 'devices', 'laptop');
    const blob = fs
      .readdirSync(dir)
      .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
      .join('\n');
    expect(blob).toContain('an observation worth sharing');
    for (const leak of ['what does laptop know?', 'laptop typed something private', 'receipt-laptop', 'enforced']) {
      expect(blob).not.toContain(leak);
    }
  });
});

describe('off by default', () => {
  it('does nothing at all when sync is disabled', () => {
    note(laptop, 'private');
    const off = configFor('laptop', { enabled: false });

    expect(push(laptop, off)).toMatchObject({ ok: false, reason: 'disabled', written: 0 });
    expect(pull(laptop, off)).toMatchObject({ ok: false, reason: 'disabled', applied: 0 });
    expect(syncStatus(laptop, off)).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fs.readdirSync(shared)).toEqual([]);
  });

  it('does nothing when it is enabled with nowhere to write', () => {
    note(laptop, 'private');
    const untargeted = configFor('laptop', { target: null });

    expect(push(laptop, untargeted)).toMatchObject({ ok: false, reason: 'no-target', written: 0 });
    expect(pull(laptop, untargeted)).toMatchObject({ ok: false, reason: 'no-target', applied: 0 });
    expect(syncStatus(laptop, untargeted)).toMatchObject({ ok: false, reason: 'no-target' });
    expect(fs.readdirSync(shared)).toEqual([]);
  });

  it('is off in the shipped defaults', () => {
    expect(DEFAULT_CONFIG.sync).toEqual({ enabled: false, target: null, device_id: null });
  });

  it('reports what a push would send without sending it', () => {
    note(laptop, 'one');
    note(laptop, 'two');
    const status = syncStatus(laptop, LAPTOP);
    expect(status).toMatchObject({ ok: true, device_id: 'laptop', pending: 2, local_revision: 0 });
    expect(status.peers).toEqual([]);
    expect(fs.existsSync(path.join(shared, 'devices'))).toBe(false);

    push(laptop, LAPTOP);
    expect(syncStatus(laptop, LAPTOP)).toMatchObject({ pending: 0, local_revision: 2 });
  });
});

describe('a device id names a directory, so it has to be one', () => {
  it('refuses a pinned device id that would write outside the target', () => {
    // `path.join(target, 'devices', '../../../../tmp/evil')` resolves happily,
    // and `mkdirSync(..., { recursive: true })` creates whatever it names.
    const db = openDb(':memory:');
    try {
      // Not the empty string: an empty pin means "not pinned", and mints one.
      for (const bad of ['../../../../tmp/evil', 'a/b', 'has space', '.', '..', 'x'.repeat(65)]) {
        const config = {
          ...DEFAULT_CONFIG,
          sync: { enabled: true, target: '/tmp/whatever', device_id: bad },
        };
        expect(() => deviceId(db, config), JSON.stringify(bad)).toThrow(/device_id|unsafe/i);
      }
    } finally {
      db.close();
    }
  });

  it('accepts the shape it mints for itself', () => {
    const db = openDb(':memory:');
    try {
      const minted = deviceId(db, DEFAULT_CONFIG);
      expect(minted).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      const pinned = { ...DEFAULT_CONFIG, sync: { enabled: true, target: '/tmp/x', device_id: 'laptop-2' } };
      expect(deviceId(db, pinned)).toBe('laptop-2');
    } finally {
      db.close();
    }
  });
});
