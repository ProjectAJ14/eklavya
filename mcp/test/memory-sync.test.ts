import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { deleteEntry, insertEntry, entryTags, supersedeEntry, timeline } from '../src/memory/store.js';
import { search } from '../src/memory/search.js';
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

describe('corrections', () => {
  /** A correction as `memory_correct` makes one: a new row, then the old one pointed at it. */
  function correct(db: DB, staleId: number, title: string): number {
    const id = note(db, title, { occurredAt: '2026-09-01T11:00:00.000Z' });
    supersedeEntry(db, staleId, id);
    return id;
  }

  function live(db: DB, query: string): string[] {
    return search(db, query, 'keyword', { project: PROJECT }).map((h) => h.entry.title);
  }

  function supersededBy(db: DB, uid: string): number | null {
    return (db.prepare('SELECT superseded_by FROM memory_entries WHERE entry_uid = ?').get(uid) as {
      superseded_by: number | null;
    }).superseded_by;
  }

  function recordFile(device: string, revision: number): string {
    return path.join(shared, 'devices', device, `${String(revision).padStart(12, '0')}.json`);
  }

  it('carries a correction to the other device, so only the replacement is live there', () => {
    const oldId = note(laptop, 'quasar uses port 80');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    expect(live(desktop, 'quasar')).toEqual(['quasar uses port 80']);

    const newId = correct(laptop, oldId, 'quasar uses port 8080');
    expect(push(laptop, LAPTOP).staged).toBe(2);
    const pulled = pull(desktop, DESKTOP);
    expect(pulled).toMatchObject({ applied: 2, conflicts: 0 });

    // The record names the replacement by uid, never by a local row id.
    const record = [2, 3]
      .map((r) => JSON.parse(fs.readFileSync(recordFile('laptop', r), 'utf8')))
      .find((r) => r.entry_uid === uidOf(laptop, oldId));
    expect(record.superseded_by).toBe(uidOf(laptop, newId));

    expect(live(desktop, 'quasar')).toEqual(['quasar uses port 8080']);
    // The original stays, as the audit trail, pointing at the local replacement.
    expect(supersededBy(desktop, uidOf(laptop, oldId))).toBe(entryByUid(desktop, uidOf(laptop, newId))!.id);
  });

  it('resolves a correction that arrives before its replacement', () => {
    const oldId = note(laptop, 'nebula retries twice');
    const newId = correct(laptop, oldId, 'nebula retries three times');
    push(laptop, LAPTOP);
    // The original is revision 1 and its replacement revision 2. Hold the
    // replacement back, as a sync client still copying it would.
    const held = fs.readFileSync(recordFile('laptop', 2), 'utf8');
    fs.rmSync(recordFile('laptop', 2));

    pull(desktop, DESKTOP);
    const oldUid = uidOf(laptop, oldId);
    expect(entryByUid(desktop, uidOf(laptop, newId))).toBeUndefined();
    expect(desktop.prepare('SELECT * FROM sync_supersessions').all()).toEqual([
      { entry_uid: oldUid, replacement_uid: uidOf(laptop, newId) },
    ]);
    // Nothing to replace it with yet, so the original is still the claim here;
    // but the waiting link is part of what this device holds, so its own push
    // cannot publish the original as uncorrected.
    expect(live(desktop, 'nebula')).toEqual(['nebula retries twice']);
    expect(push(desktop, DESKTOP).staged).toBe(0);

    fs.writeFileSync(recordFile('laptop', 2), held);
    // Reset the mark the gap let past, as a resumed stream would re-read it.
    desktop.prepare("UPDATE sync_state SET last_revision = 1 WHERE device_id = 'laptop'").run();
    pull(desktop, DESKTOP);
    expect(live(desktop, 'nebula')).toEqual(['nebula retries three times']);
    expect(supersededBy(desktop, oldUid)).toBe(entryByUid(desktop, uidOf(laptop, newId))!.id);
    expect(desktop.prepare('SELECT COUNT(*) AS n FROM sync_supersessions').get()).toEqual({ n: 0 });
  });

  it('does not revive the stale claim on a round trip', () => {
    const oldId = note(laptop, 'pulsar flag defaults on');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    correct(laptop, oldId, 'pulsar flag defaults off');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    expect(push(desktop, DESKTOP).staged).toBe(0);
    expect(pull(laptop, LAPTOP)).toMatchObject({ applied: 0, conflicts: 0 });
    expect(live(laptop, 'pulsar')).toEqual(['pulsar flag defaults off']);
    expect(live(desktop, 'pulsar')).toEqual(['pulsar flag defaults off']);
  });

  it('sends a correction made before corrections travelled, and nothing else', () => {
    // An upgraded database: both rows were pushed under the old hash, which
    // left the link out, so the peer holds both as live.
    const keep = note(laptop, 'comet cache is warm');
    const oldId = note(laptop, 'comet ttl is 60s');
    const newId = note(laptop, 'comet ttl is 300s');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    laptop.prepare('UPDATE memory_entries SET superseded_by = ? WHERE id = ?').run(newId, oldId);

    const pushed = push(laptop, LAPTOP);
    expect(pushed.staged).toBe(1);
    pull(desktop, DESKTOP);
    expect(live(desktop, 'comet ttl')).toEqual(['comet ttl is 300s']);
    expect(supersededBy(desktop, uidOf(laptop, keep))).toBeNull();
  });

  it('refuses a record whose correction was altered after it was written', () => {
    const oldId = note(laptop, 'aurora build is cached');
    correct(laptop, oldId, 'aurora build is not cached');
    push(laptop, LAPTOP);
    const file = recordFile('laptop', 1);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, superseded_by: 'someone-else' }));

    expect(pull(desktop, DESKTOP).stalled).toEqual(['laptop']);
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

describe('out-of-order delivery', () => {
  const laptopDir = () => path.join(shared, 'devices', 'laptop');
  const recordFile = (rev: number) => path.join(laptopDir(), `${String(rev).padStart(12, '0')}.json`);
  const parked = (rev: number) => path.join(shared, `parked-${rev}.json`);
  /** A cloud client that has not delivered this revision yet. */
  const delay = (rev: number) => fs.renameSync(recordFile(rev), parked(rev));
  const deliver = (rev: number) => fs.renameSync(parked(rev), recordFile(rev));
  const floor = (db: DB) =>
    (db.prepare("SELECT last_revision FROM sync_state WHERE device_id = 'laptop'").get() as { last_revision: number })
      .last_revision;
  const receipts = (db: DB) => (db.prepare('SELECT COUNT(*) AS n FROM sync_received').get() as { n: number }).n;

  it('applies a record that arrives after a later one, exactly once', () => {
    note(laptop, 'first');
    note(laptop, 'second');
    push(laptop, LAPTOP);
    delay(1);

    const early = pull(desktop, DESKTOP);
    expect(early).toMatchObject({ applied: 1, stalled: [], outstanding: [{ device_id: 'laptop', missing: 1, first: 1 }] });
    expect(titles(desktop)).toEqual(['second']);
    expect(floor(desktop)).toBe(0);
    expect(syncStatus(desktop, DESKTOP).peers).toEqual([expect.objectContaining({ device_id: 'laptop', outstanding: 1 })]);

    deliver(1);
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, skipped: 0, outstanding: [] });
    expect(titles(desktop)).toEqual(['first', 'second']);
    expect(floor(desktop)).toBe(2);
    expect(receipts(desktop)).toBe(0);
    expect(syncStatus(desktop, DESKTOP).peers).toEqual([expect.objectContaining({ last_revision: 2, outstanding: 0 })]);

    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 0, skipped: 0, conflicts: 0 });
  });

  it('propagates a deletion that arrives late', () => {
    const doomed = note(laptop, 'doomed');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    deleteEntry(laptop, doomed);
    note(laptop, 'newer');
    push(laptop, LAPTOP);
    const tomb = [2, 3].find((r) => JSON.parse(fs.readFileSync(recordFile(r), 'utf8')).op === 'delete')!;
    delay(tomb);

    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, tombstones: 0 });
    expect(titles(desktop)).toEqual(['doomed', 'newer']);

    deliver(tomb);
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, tombstones: 1, outstanding: [] });
    expect(titles(desktop)).toEqual(['newer']);
  });

  it('keeps a deletion when the creation it buries arrives after it', () => {
    const id = note(laptop, 'short-lived');
    push(laptop, LAPTOP);
    deleteEntry(laptop, id);
    push(laptop, LAPTOP);
    delay(1);

    expect(pull(desktop, DESKTOP)).toMatchObject({ tombstones: 1 });
    deliver(1);
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 0, skipped: 1, conflicts: 0, outstanding: [] });
    expect(titles(desktop)).toEqual([]);
  });

  it('does not reapply a record delivered twice or a pull interrupted before its floor moved', () => {
    note(laptop, 'first');
    note(laptop, 'second');
    push(laptop, LAPTOP);
    delay(1);
    pull(desktop, DESKTOP);

    // The cloud client hands revision 2 over again.
    const again = fs.readFileSync(recordFile(2), 'utf8');
    fs.rmSync(recordFile(2));
    fs.writeFileSync(recordFile(2), again, 'utf8');
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 0, skipped: 0 });

    // Both applied, then the process died before the floor caught up.
    deliver(1);
    pull(desktop, DESKTOP);
    desktop.prepare("UPDATE sync_state SET last_revision = 0 WHERE device_id = 'laptop'").run();
    desktop.prepare("INSERT INTO sync_received (device_id, revision) VALUES ('laptop', 1), ('laptop', 2)").run();
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 0, skipped: 0, conflicts: 0, outstanding: [] });
    expect(floor(desktop)).toBe(2);
    expect(receipts(desktop)).toBe(0);
    expect(titles(desktop)).toEqual(['first', 'second']);
  });

  it('steps over a revision its writer abandoned instead of waiting for it', () => {
    const id = note(laptop, 'draft');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    // Revision 1 was staged but its file never landed, and the entry moved on:
    // the next push stages revision 2 and nothing can ever write revision 1.
    fs.rmSync(recordFile(1));
    laptop.prepare("UPDATE memory_entries SET narrative = 'final' WHERE id = ?").run(id);
    push(laptop, LAPTOP);
    expect(JSON.parse(fs.readFileSync(path.join(laptopDir(), 'void.json'), 'utf8'))).toEqual({
      v: 1,
      device_id: 'laptop',
      revisions: [[1, 1]],
    });

    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, outstanding: [] });
    expect(entryByUid(desktop, uid)!.narrative).toBe('final');
    expect(floor(desktop)).toBe(2);
    expect(receipts(desktop)).toBe(0);
  });

  it('does not void a record that iCloud evicted to save space', () => {
    note(laptop, 'kept');
    push(laptop, LAPTOP);
    fs.renameSync(recordFile(1), path.join(laptopDir(), '.000000000001.json.icloud'));
    note(laptop, 'later');
    push(laptop, LAPTOP);
    expect(fs.existsSync(path.join(laptopDir(), 'void.json'))).toBe(false);
  });

  it('applies the records after an unreadable one, and reads that one once it is whole', () => {
    note(laptop, 'first');
    note(laptop, 'second');
    push(laptop, LAPTOP);
    const whole = fs.readFileSync(recordFile(1), 'utf8');
    fs.writeFileSync(recordFile(1), whole.slice(0, 20), 'utf8');

    expect(pull(desktop, DESKTOP)).toMatchObject({
      applied: 1,
      stalled: ['laptop'],
      outstanding: [{ device_id: 'laptop', missing: 1, first: 1 }],
    });
    expect(titles(desktop)).toEqual(['second']);

    fs.writeFileSync(recordFile(1), whole, 'utf8');
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, stalled: [], outstanding: [] });
    expect(titles(desktop)).toEqual(['first', 'second']);
    expect(floor(desktop)).toBe(2);
  });

  it('still quarantines a late record that really conflicts', () => {
    const id = note(laptop, 'shared');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    desktop.prepare("UPDATE memory_entries SET narrative = 'desktop edit' WHERE entry_uid = ?").run(uid);
    push(desktop, DESKTOP);
    laptop.prepare("UPDATE memory_entries SET narrative = 'laptop edit' WHERE id = ?").run(id);
    push(laptop, LAPTOP); // revision 2
    note(laptop, 'later');
    push(laptop, LAPTOP); // revision 3, which shows revision 2 exists
    delay(2);

    expect(pull(desktop, DESKTOP)).toMatchObject({ conflicts: 0, outstanding: [{ device_id: 'laptop', missing: 1 }] });
    deliver(2);
    expect(pull(desktop, DESKTOP)).toMatchObject({ conflicts: 1, outstanding: [] });
    expect(entryByUid(desktop, uid)!.narrative).toBe('desktop edit');
    expect(conflicts(desktop)).toHaveLength(1);
  });

  it('does not step over a voided revision whose file is present but unreadable', () => {
    note(laptop, 'first');
    note(laptop, 'second');
    push(laptop, LAPTOP);
    const whole = fs.readFileSync(recordFile(1), 'utf8');
    fs.writeFileSync(recordFile(1), '{"half":', 'utf8');
    // A writer that wrongly claims revision 1 will never exist.
    fs.writeFileSync(path.join(laptopDir(), 'void.json'), JSON.stringify({ v: 1, device_id: 'laptop', revisions: [[1, 1]] }));

    expect(pull(desktop, DESKTOP)).toMatchObject({ outstanding: [{ device_id: 'laptop', missing: 1, first: 1 }] });
    expect(floor(desktop)).toBe(0);
    fs.writeFileSync(recordFile(1), whole, 'utf8');
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, outstanding: [] });
    expect(titles(desktop)).toEqual(['first', 'second']);
  });

  it('does not step past the newest revision on a void list, so a later file still lands', () => {
    note(laptop, 'first');
    push(laptop, LAPTOP);
    fs.writeFileSync(path.join(laptopDir(), 'void.json'), JSON.stringify({ v: 1, device_id: 'laptop', revisions: [[2, 9]] }));
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, outstanding: [] });
    expect(floor(desktop)).toBe(1);

    note(laptop, 'second');
    push(laptop, LAPTOP); // revision 2, which the bogus list called void
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1 });
    expect(titles(desktop)).toEqual(['first', 'second']);
  });

  it('counts a huge revision gap without walking it', () => {
    note(laptop, 'first');
    push(laptop, LAPTOP);
    const last = 999_999_999_999;
    fs.writeFileSync(path.join(laptopDir(), `${last}.json`), '{}', 'utf8');

    const started = Date.now();
    expect(pull(desktop, DESKTOP)).toMatchObject({
      applied: 1,
      stalled: ['laptop'],
      outstanding: [{ device_id: 'laptop', missing: last - 1, first: 2 }],
    });
    fs.writeFileSync(path.join(laptopDir(), 'void.json'), JSON.stringify({ v: 1, device_id: 'laptop', revisions: [[1, last]] }));
    expect(pull(desktop, DESKTOP)).toMatchObject({ outstanding: [{ device_id: 'laptop', missing: 1, first: last }] });
    expect(floor(desktop)).toBe(last - 1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('skips the version a later one replaced, even from another device', () => {
    const id = note(laptop, 'shared');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    desktop.prepare("UPDATE memory_entries SET narrative = 'desktop edit' WHERE entry_uid = ?").run(uid);
    push(desktop, DESKTOP);

    // A third device that sees the desktop's edit before the laptop's original.
    const tabletFile = tempDbPath('eklavya-sync-tablet');
    const tablet = openDb(tabletFile);
    try {
      expect(pull(tablet, configFor('tablet'))).toMatchObject({ applied: 1, skipped: 1, conflicts: 0 });
      expect(entryByUid(tablet, uid)!.narrative).toBe('desktop edit');
      expect(conflicts(tablet)).toEqual([]);
    } finally {
      tablet.close();
      cleanup(tabletFile);
    }
  });
});

describe('recovering records an earlier release stepped over', () => {
  const recordFile = (rev: number) => path.join(shared, 'devices', 'laptop', `${String(rev).padStart(12, '0')}.json`);
  const parked = (rev: number) => path.join(shared, `parked-${rev}.json`);
  /**
   * The state an older release left behind: it applied what had arrived and
   * moved the mark past the revision that had not. The upgrade sets
   * `replay_through` to that mark.
   */
  function pulledByOldRelease(missing: number, mark: number): void {
    fs.renameSync(recordFile(missing), parked(missing));
    pull(desktop, DESKTOP);
    desktop.prepare('DELETE FROM sync_received').run();
    desktop
      .prepare("UPDATE sync_state SET last_revision = ?, replay_through = ? WHERE device_id = 'laptop'")
      .run(mark, mark);
    fs.renameSync(parked(missing), recordFile(missing));
  }

  it('applies a skipped entry once, on the first pull after upgrading', () => {
    note(laptop, 'first');
    note(laptop, 'second');
    push(laptop, LAPTOP);
    pulledByOldRelease(1, 2);
    expect(titles(desktop)).toEqual(['second']);

    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, recovered: 1, conflicts: 0, outstanding: [] });
    expect(titles(desktop)).toEqual(['first', 'second']);
    expect(
      desktop.prepare("SELECT replay_through FROM sync_state WHERE device_id = 'laptop'").get(),
    ).toEqual({ replay_through: 0 });
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 0, recovered: 0, skipped: 0 });
  });

  it('applies a skipped deletion', () => {
    const doomed = note(laptop, 'doomed');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    deleteEntry(laptop, doomed);
    push(laptop, LAPTOP); // revision 2: the tombstone
    note(laptop, 'later');
    push(laptop, LAPTOP); // revision 3
    pulledByOldRelease(2, 3);
    expect(titles(desktop)).toEqual(['doomed', 'later']);

    expect(pull(desktop, DESKTOP)).toMatchObject({ recovered: 1, tombstones: 1 });
    expect(titles(desktop)).toEqual(['later']);
  });

  it('leaves a skipped record that would conflict exactly as it is', () => {
    const id = note(laptop, 'shared');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    desktop.prepare("UPDATE memory_entries SET narrative = 'desktop edit' WHERE entry_uid = ?").run(uid);
    push(desktop, DESKTOP);
    laptop.prepare("UPDATE memory_entries SET narrative = 'laptop edit' WHERE id = ?").run(id);
    note(laptop, 'other');
    push(laptop, LAPTOP); // revisions 2 (the conflicting edit) and 3
    pulledByOldRelease(2, 3);

    expect(pull(desktop, DESKTOP)).toMatchObject({ recovered: 0, conflicts: 0 });
    expect(entryByUid(desktop, uid)!.narrative).toBe('desktop edit');
    expect(conflicts(desktop)).toEqual([]);
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
