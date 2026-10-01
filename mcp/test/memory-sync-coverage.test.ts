import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { deleteEntry, insertEntry } from '../src/memory/store.js';
import { conflicts, pull, push, repairConflict, syncStatus } from '../src/memory/sync.js';
import { cleanup, tempDbPath } from './helpers.js';

/** The edges of the shared-folder protocol that memory-sync.test.ts leaves out. */
const PROJECT = '/tmp/shared-repo';

let laptopFile = '';
let desktopFile = '';
let shared = '';
let laptop: DB;
let desktop: DB;
let LAPTOP: EklavyaConfig;
let DESKTOP: EklavyaConfig;

const configFor = (device: string): EklavyaConfig => ({
  ...DEFAULT_CONFIG,
  sync: { enabled: true, target: shared, device_id: device },
});

function note(db: DB, title: string, over: object = {}): number {
  return insertEntry(db, {
    project: PROJECT,
    title,
    narrative: `about ${title}`,
    occurredAt: '2026-09-01T10:00:00.000Z',
    ...over,
  } as Parameters<typeof insertEntry>[1]);
}

const uidOf = (db: DB, id: number) =>
  (db.prepare('SELECT entry_uid FROM memory_entries WHERE id = ?').get(id) as { entry_uid: string }).entry_uid;
const row = (db: DB, uid: string) =>
  db.prepare('SELECT * FROM memory_entries WHERE entry_uid = ?').get(uid) as
    | { id: number; title: string; narrative: string; deleted_at: string | null }
    | undefined;
const laptopDir = () => path.join(shared, 'devices', 'laptop');
const recordFile = (rev: number) => path.join(laptopDir(), `${String(rev).padStart(12, '0')}.json`);
const edit = (db: DB, id: number, narrative: string) =>
  db.prepare('UPDATE memory_entries SET narrative = ? WHERE id = ?').run(narrative, id);

beforeEach(() => {
  laptopFile = tempDbPath('eklavya-synccov-laptop');
  desktopFile = tempDbPath('eklavya-synccov-desktop');
  shared = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-synccov-target-'));
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

describe('pulling from a folder with nothing usable in it', () => {
  it('applies nothing when no device has written yet', () => {
    expect(pull(desktop, DESKTOP)).toMatchObject({ ok: true, applied: 0, stalled: [] });
  });

  it('skips a peer directory whose name is not a device id', () => {
    note(laptop, 'real');
    push(laptop, LAPTOP);
    fs.mkdirSync(path.join(shared, 'devices', 'not.a.device'));
    fs.writeFileSync(path.join(shared, 'devices', 'not.a.device', '000000000001.json'), '{}');
    const pulled = pull(desktop, DESKTOP);
    expect(pulled.applied).toBe(1);
    expect(pulled.stalled).toEqual([]);
  });
});

describe('records that are not whole, self-consistent ones', () => {
  const cases: [string, (rec: Record<string, unknown>) => unknown][] = [
    ['not an object', () => 5],
    ['a later wire format', (r) => ({ ...r, v: 2 })],
    ['the wrong device', (r) => ({ ...r, device_id: 'desktop' })],
    ['the wrong revision', (r) => ({ ...r, revision: 9 })],
    ['no entry uid', (r) => ({ ...r, entry_uid: '' })],
    ['an unknown op', (r) => ({ ...r, op: 'merge' })],
    ['an upsert with no entry object', (r) => ({ ...r, entry: 'text' })],
    ['an entry with no title', (r) => ({ ...r, entry: { ...(r.entry as object), title: 7 } })],
  ];
  for (const [label, mutate] of cases) {
    it(`stalls the stream on ${label}`, () => {
      note(laptop, 'honest');
      push(laptop, LAPTOP);
      const rec = JSON.parse(fs.readFileSync(recordFile(1), 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(recordFile(1), JSON.stringify(mutate(rec)));
      const pulled = pull(desktop, DESKTOP);
      expect(pulled.applied).toBe(0);
      expect(pulled.stalled).toEqual(['laptop']);
    });
  }

  it('reads a record whose tags are not a list as having none', () => {
    note(laptop, 'untagged');
    push(laptop, LAPTOP);
    const rec = JSON.parse(fs.readFileSync(recordFile(1), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(recordFile(1), JSON.stringify({ ...rec, tags: 'x', base: undefined }));
    expect(pull(desktop, DESKTOP).applied).toBe(1);
  });
});

describe('push edges', () => {
  it('honours an explicit target over the configured one', () => {
    note(laptop, 'elsewhere');
    const unconfigured = { ...LAPTOP, sync: { ...LAPTOP.sync, target: null } };
    expect(push(laptop, unconfigured).reason).toBe('no-target');
    expect(push(laptop, unconfigured, { target: `  ${shared}  ` })).toMatchObject({ ok: true, written: 1, target: shared });
    expect(syncStatus(laptop, unconfigured, { target: shared })).toMatchObject({ ok: true, local_revision: 1, pending: 0 });
  });

  it('publishes a hard delete as a tombstone', () => {
    const id = note(laptop, 'gone');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    laptop.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    expect(syncStatus(laptop, LAPTOP).pending).toBe(1);
    const pushed = push(laptop, LAPTOP);
    expect(pushed).toMatchObject({ staged: 1, written: 1 });
    expect(JSON.parse(fs.readFileSync(recordFile(2), 'utf8'))).toMatchObject({ op: 'delete', entry: null });

    expect(pull(desktop, DESKTOP).tombstones).toBe(1);
    expect(row(desktop, uid)!.deleted_at).not.toBeNull();
  });

  it('rewrites a lost tombstone file from the database', () => {
    const id = note(laptop, 'doomed');
    push(laptop, LAPTOP);
    deleteEntry(laptop, id);
    push(laptop, LAPTOP);
    fs.rmSync(recordFile(2));

    const resumed = push(laptop, LAPTOP);
    // One record per entry: the tombstone replaced revision 1, so only it is owed.
    expect(resumed).toMatchObject({ staged: 0, written: 1, already: 0 });
    expect(JSON.parse(fs.readFileSync(recordFile(2), 'utf8'))).toMatchObject({ op: 'delete', entry: null, tags: [] });
  });

  it('does not rewrite a lost file whose content no longer matches its record', () => {
    const id = note(laptop, 'soft deleted');
    push(laptop, LAPTOP);
    fs.rmSync(recordFile(1));
    // A deleted row whose record still says upsert, with the tombstone's hash:
    // nothing to stage, and nothing the upsert can be rebuilt from.
    laptop.prepare("UPDATE memory_entries SET deleted_at = '2026-09-02T00:00:00.000Z' WHERE id = ?").run(id);
    push(laptop, LAPTOP); // stages the tombstone as revision 2
    fs.rmSync(recordFile(2));
    const tombHash = (laptop.prepare('SELECT hash FROM sync_records').get() as { hash: string }).hash;
    laptop.prepare("UPDATE sync_records SET op = 'upsert', hash = ?").run(tombHash);

    const resumed = push(laptop, LAPTOP);
    expect(resumed).toMatchObject({ staged: 0, written: 0 });
    expect(fs.existsSync(recordFile(2))).toBe(false);
  });
});

describe('merging', () => {
  it('fast-forwards a later revision from the same device even past a missing one', () => {
    const id = note(laptop, 'evolving');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);

    edit(laptop, id, 'second');
    push(laptop, LAPTOP);
    edit(laptop, id, 'third');
    push(laptop, LAPTOP);
    // Revision 3's base is laptop:2, which the desktop never saw.
    fs.rmSync(recordFile(2));

    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 1, conflicts: 0 });
    expect(row(desktop, uid)!.narrative).toBe('third');
  });

  it('skips an older revision from the device it already follows', () => {
    const id = note(laptop, 'evolving');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    edit(laptop, id, 'second');
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    expect(row(desktop, uid)!.narrative).toBe('second');

    // Forget the high-water mark so revision 1 is read again.
    desktop.prepare('DELETE FROM sync_state').run();
    expect(pull(desktop, DESKTOP)).toMatchObject({ applied: 0, skipped: 2, conflicts: 0 });
    expect(row(desktop, uid)!.narrative).toBe('second');
  });

  it('quarantines two independent creations under one uid, and repairs to local after a hard delete', () => {
    const id = note(laptop, 'from laptop');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    note(desktop, 'from desktop', { entryUid: uid });

    expect(pull(desktop, DESKTOP).conflicts).toBe(1);
    const [c] = conflicts(desktop);
    expect(c).toMatchObject({ entry_uid: uid, local_ref: 'local:unstaged', device_id: 'laptop' });
    expect(row(desktop, uid)!.title).toBe('from desktop');

    expect(repairConflict(desktop, DESKTOP, 999, 'local')).toBe(false);

    // The local copy went away before anybody chose: the winner is the incoming version's identity.
    desktop.prepare('DELETE FROM memory_entries WHERE entry_uid = ?').run(uid);
    expect(repairConflict(desktop, DESKTOP, c!.id, 'local')).toBe(true);
    expect(repairConflict(desktop, DESKTOP, c!.id, 'local')).toBe(false);
    const rec = desktop.prepare('SELECT * FROM sync_records WHERE entry_uid = ?').get(uid) as {
      device_id: string;
      base: string;
      op: string;
    };
    expect(rec).toMatchObject({ device_id: 'desktop', base: 'laptop:1', op: 'upsert' });

    expect(conflicts(desktop)).toEqual([]);
    expect(conflicts(desktop, true)).toHaveLength(1);
    expect(conflicts(desktop, true)[0]!.resolution).toBe('local');
  });

  it('treats an entry hard-deleted here as a tombstone when a peer version arrives', () => {
    const id = note(laptop, 'shared');
    const uid = uidOf(laptop, id);
    push(laptop, LAPTOP);
    pull(desktop, DESKTOP);
    const desktopId = row(desktop, uid)!.id;
    desktop.prepare('DELETE FROM memory_entries WHERE id = ?').run(desktopId);

    edit(laptop, id, 'edited on the laptop');
    push(laptop, LAPTOP);
    // Held is laptop:1 but what is here is a tombstone: a dirty local state, so a conflict.
    expect(pull(desktop, DESKTOP).conflicts).toBe(1);
    expect(row(desktop, uid)).toBeUndefined();
  });

  it('indexes an entry with no facts or files', () => {
    const id = note(laptop, 'bare', { facts: null, files: null });
    push(laptop, LAPTOP);
    expect(pull(desktop, DESKTOP).applied).toBe(1);
    expect(row(desktop, uidOf(laptop, id))!.title).toBe('bare');
  });
});
