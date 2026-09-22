import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { nowIso } from '../time.js';
import { deleteEntry, indexVector } from './store.js';

/**
 * Multi-device sync (ADR-09): a shared **directory**, not a server.
 *
 * The whole protocol is files on disk. Each device appends numbered revision
 * records under its own folder and reads what the others wrote; Dropbox, iCloud
 * Drive, Syncthing, a mounted share or a git repository all work because none of
 * them is a dependency -- the target is a path. The hosted, authenticated team
 * server is deliberately not built, and ADR-09 is where that is recorded.
 *
 *   <target>/devices/<device_id>/000000000001.json
 *
 * One file per record, named by revision, zero-padded so lexical order is
 * numeric order. That shape buys three properties nothing else here has to work
 * for. A pull is incremental, because the reader skips filenames at or below the
 * high-water mark without opening them. A push resumes, because a record's path
 * is a function of (device, revision) and a file already there is already sent.
 * And a reader never sees half a record, because every write is temp-then-rename
 * -- with a payload hash as the second line of defence for the cases rename does
 * not cover, such as a cloud client materialising a partial file under the real
 * name.
 *
 * **What crosses, and what must not.** Memory entries, their tags and their
 * tombstones. Not attempts, not mastery, not gates, not receipts, not raw
 * `evidence_events` (PRD SEC-02). A team that points every member at one shared
 * folder gets shared project memory; it does not thereby get everyone's quiz
 * history, and "the schema happens not to mention it" is not an enforcement.
 * `ENTRY_COLUMNS` is, and it is the only list any payload is built from or
 * applied through.
 */

/** The wire format. Bump when the record shape changes. */
export const SYNC_FORMAT_VERSION = 1;

/**
 * The only columns that ever leave this machine.
 *
 * An allowlist rather than `SELECT *`, so a later migration adding a column to
 * `memory_entries` does not silently start publishing it. `session_id`,
 * `batch_id` and `superseded_by` are left out for a different reason: they are
 * local row ids and mean nothing on the other device.
 */
const ENTRY_COLUMNS = [
  'project',
  'kind',
  'type',
  'title',
  'narrative',
  'facts',
  'files',
  'generator',
  'confidence',
  'occurred_at',
  'created_at',
  'import_source',
] as const;

type EntryPayload = Record<(typeof ENTRY_COLUMNS)[number], unknown>;

export interface SyncRecord {
  v: number;
  device_id: string;
  revision: number;
  /** `<device>:<revision>` this version replaced, or null for a first write. */
  base: string | null;
  entry_uid: string;
  op: 'upsert' | 'delete';
  hash: string;
  written_at: string;
  /** Null for a tombstone: a deletion propagates the fact, never the text. */
  entry: EntryPayload | null;
  tags: string[];
}

export interface SyncOutcome {
  ok: boolean;
  /** Why nothing happened: sync off, or on with nowhere to write. */
  reason?: 'disabled' | 'no-target';
  device_id?: string;
  target?: string;
}

export interface PushResult extends SyncOutcome {
  /** Local changes that earned a new revision this run. */
  staged: number;
  /** Record files written to the target. */
  written: number;
  /** Records already in the target -- an interrupted push resuming. */
  already: number;
}

export interface PullResult extends SyncOutcome {
  applied: number;
  tombstones: number;
  /** Records already reflected here, or superseded by a local edit of equal content. */
  skipped: number;
  conflicts: number;
  /** Devices whose stream stopped early on an unreadable record. */
  stalled: string[];
}

export interface SyncStatus extends SyncOutcome {
  enabled: boolean;
  configured_target: string | null;
  local_revision: number;
  /** Local changes a push would stage, tombstones included. */
  pending: number;
  open_conflicts: number;
  peers: { device_id: string; last_revision: number; last_sync_at: string | null }[];
}

const DEVICE_ID_KEY = 'sync_device_id';

/**
 * This install's identity, generated once.
 *
 * Kept in `meta` rather than in the config file, and the difference matters.
 * Config travels: `~/.eklavya/config.json` is
 * what a dotfile manager copies to the second machine. Two devices sharing an id
 * would interleave one revision stream and each would read the other's writes as
 * its own already-applied history -- a silent, unrecoverable merge. `meta` lives
 * in `knowledge.db`, which is per-install, and which the importer is already
 * forbidden to copy foreign device identity into (PRD MIG-01).
 *
 * `sync.device_id` in the config overrides it when someone means to pin it.
 */
/**
 * A device id becomes a directory name under the sync target, so it has to be
 * one path segment and nothing else. Without this, a pinned
 * `device_id: "../../../../tmp/evil"` writes outside the target — `path.join`
 * resolves it happily and `mkdirSync(..., {recursive: true})` creates whatever
 * it names.
 */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function deviceId(db: DB, config: EklavyaConfig): string {
  const pinned = config.sync.device_id?.trim();
  if (pinned) {
    if (!DEVICE_ID.test(pinned)) {
      throw new Error(
        `sync.device_id must be 1-64 characters of letters, digits, "-" or "_" (got ${JSON.stringify(pinned)}). It names a directory under the sync target.`,
      );
    }
    return pinned;
  }

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(DEVICE_ID_KEY) as
    | { value: string }
    | undefined;
  if (row?.value) return row.value;

  const minted = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(DEVICE_ID_KEY, minted);
  return (
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(DEVICE_ID_KEY) as { value: string }).value
  );
}

/** Resolves the target, honouring an explicit `--target` over the config. */
function resolveTarget(config: EklavyaConfig, override?: string | null): string | null {
  const chosen = override?.trim() || config.sync.target?.trim();
  return chosen ? path.resolve(chosen) : null;
}

function guard(db: DB, config: EklavyaConfig, override?: string | null):
  | { ok: false; reason: 'disabled' | 'no-target' }
  | { ok: true; device: string; target: string } {
  if (!config.sync.enabled) return { ok: false, reason: 'disabled' };
  const target = resolveTarget(config, override);
  if (!target) return { ok: false, reason: 'no-target' };
  return { ok: true, device: deviceId(db, config), target };
}

// ---------------------------------------------------------------------------
// Hashing and the version vector
// ---------------------------------------------------------------------------

/** Content identity of a version. Equal hashes mean nothing has to be sent. */
function payloadHash(op: 'upsert' | 'delete', entry: EntryPayload | null, tags: string[]): string {
  const h = crypto.createHash('sha256');
  // Canonical by construction: ENTRY_COLUMNS is ordered and tags are sorted, so
  // two devices holding the same content always agree on the hash.
  h.update(JSON.stringify([op, entry ? ENTRY_COLUMNS.map((c) => entry[c] ?? null) : null, [...tags].sort()]));
  return h.digest('hex').slice(0, 32);
}

function ref(device: string, revision: number): string {
  return `${device}:${revision}`;
}

interface RecordRow {
  entry_uid: string;
  device_id: string;
  revision: number;
  base: string | null;
  op: string;
  hash: string;
}

function localRecord(db: DB, entryUid: string): RecordRow | undefined {
  return db.prepare('SELECT * FROM sync_records WHERE entry_uid = ?').get(entryUid) as
    | RecordRow
    | undefined;
}

function highWater(db: DB, device: string): number {
  const row = db.prepare('SELECT last_revision FROM sync_state WHERE device_id = ?').get(device) as
    | { last_revision: number }
    | undefined;
  return row?.last_revision ?? 0;
}

function setHighWater(db: DB, device: string, revision: number): void {
  db.prepare(
    `INSERT INTO sync_state (device_id, last_revision, last_sync_at) VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       last_revision = MAX(last_revision, excluded.last_revision),
       last_sync_at = excluded.last_sync_at`,
  ).run(device, revision, nowIso());
}

function nextRevision(db: DB, device: string): number {
  const next = highWater(db, device) + 1;
  setHighWater(db, device, next);
  return next;
}

function writeRecord(db: DB, rec: Pick<SyncRecord, 'entry_uid' | 'device_id' | 'revision' | 'base' | 'op' | 'hash'>): void {
  db.prepare(
    `INSERT INTO sync_records (entry_uid, device_id, revision, base, op, hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_uid) DO UPDATE SET
       device_id = excluded.device_id, revision = excluded.revision, base = excluded.base,
       op = excluded.op, hash = excluded.hash, updated_at = excluded.updated_at`,
  ).run(rec.entry_uid, rec.device_id, rec.revision, rec.base, rec.op, rec.hash, nowIso());
}

// ---------------------------------------------------------------------------
// Local scan
// ---------------------------------------------------------------------------

interface Staged {
  entry_uid: string;
  op: 'upsert' | 'delete';
  entry: EntryPayload | null;
  tags: string[];
  hash: string;
}

function tombstone(entryUid: string): Staged {
  return { entry_uid: entryUid, op: 'delete', entry: null, tags: [], hash: payloadHash('delete', null, []) };
}

function tagsOf(db: DB, entryUid: string): string[] {
  return (
    db
      .prepare(
        'SELECT tag FROM memory_entry_tags t JOIN memory_entries e ON e.id = t.entry_id WHERE e.entry_uid = ? ORDER BY tag',
      )
      .all(entryUid) as { tag: string }[]
  ).map((t) => t.tag);
}

function stage(db: DB, row: EntryPayload & { entry_uid: string; deleted_at: string | null }): Staged {
  if (row.deleted_at !== null) return tombstone(row.entry_uid);
  const entry = Object.fromEntries(ENTRY_COLUMNS.map((c) => [c, row[c] ?? null])) as EntryPayload;
  const tags = tagsOf(db, row.entry_uid);
  return { entry_uid: row.entry_uid, op: 'upsert', entry, tags, hash: payloadHash('upsert', entry, tags) };
}

/**
 * What this device holds for one entry right now, whether or not it has been
 * staged. Null when the entry is unknown here in every sense.
 */
function localContent(db: DB, entryUid: string): Staged | null {
  const row = db
    .prepare(`SELECT entry_uid, deleted_at, ${ENTRY_COLUMNS.join(', ')} FROM memory_entries WHERE entry_uid = ?`)
    .get(entryUid) as (EntryPayload & { entry_uid: string; deleted_at: string | null }) | undefined;
  if (row) return stage(db, row);
  // No row, but a record that outlived it: a hard delete. Still a tombstone.
  return localRecord(db, entryUid) ? tombstone(entryUid) : null;
}

/**
 * What a push would send: every entry whose content no longer matches its
 * record, plus tombstones.
 *
 * ponytail: a full scan of `memory_entries` per push rather than a write-time
 * hook, because a hook means every call site in `memory/store.ts` remembering to
 * call it and a corpus this size is a millisecond. Add the hook if a push ever
 * shows up in a profile.
 */
function scanLocal(db: DB): Staged[] {
  const rows = db
    .prepare(`SELECT entry_uid, deleted_at, ${ENTRY_COLUMNS.join(', ')} FROM memory_entries`)
    .all() as (EntryPayload & { entry_uid: string; deleted_at: string | null })[];

  const out = rows
    .map((row) => stage(db, row))
    .filter((s) => localRecord(db, s.entry_uid)?.hash !== s.hash);

  // A hard delete leaves no row at all, so the tombstone has to come from the
  // record that outlived it. Without this the other device keeps its copy for
  // ever and a later edit there resurrects it here.
  const orphans = db
    .prepare(
      `SELECT entry_uid FROM sync_records
       WHERE op = 'upsert'
         AND entry_uid NOT IN (SELECT entry_uid FROM memory_entries)`,
    )
    .all() as { entry_uid: string }[];
  for (const o of orphans) out.push(tombstone(o.entry_uid));

  return out;
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

function deviceDir(target: string, device: string): string {
  // Belt and braces with the check in `deviceId`: every path built here is one
  // segment under `<target>/devices`, and a peer's directory name arrives from
  // `readdirSync` rather than from a record, but a single assertion at the one
  // place paths are built is cheaper than trusting both.
  if (!DEVICE_ID.test(device)) throw new Error(`unsafe device id: ${JSON.stringify(device)}`);
  return path.join(target, 'devices', device);
}

function recordPath(target: string, device: string, revision: number): string {
  return path.join(deviceDir(target, device), `${String(revision).padStart(12, '0')}.json`);
}

/** Temp name then rename: a reader must never see a half-written record. */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Stages local changes as new revisions and writes any local record the target
 * has not got.
 *
 * Both halves are idempotent. Staging skips an entry whose hash already matches
 * its record, and writing skips a path that already exists -- so a push killed
 * halfway resumes by writing only the remainder, and a push with nothing to do
 * writes nothing at all.
 */
export function push(db: DB, config: EklavyaConfig, opts: { target?: string | null } = {}): PushResult {
  const g = guard(db, config, opts.target);
  if (!g.ok) return { ok: false, reason: g.reason, staged: 0, written: 0, already: 0 };

  const staged = scanLocal(db);
  db.transaction(() => {
    for (const change of staged) {
      const previous = localRecord(db, change.entry_uid);
      writeRecord(db, {
        entry_uid: change.entry_uid,
        device_id: g.device,
        revision: nextRevision(db, g.device),
        base: previous ? ref(previous.device_id, previous.revision) : null,
        op: change.op,
        hash: change.hash,
      });
    }
  })();

  const payloads = new Map(staged.map((s) => [s.entry_uid, s]));
  const mine = db
    .prepare('SELECT * FROM sync_records WHERE device_id = ? ORDER BY revision')
    .all(g.device) as RecordRow[];

  let written = 0;
  let already = 0;
  for (const rec of mine) {
    const file = recordPath(g.target, g.device, rec.revision);
    if (fs.existsSync(file)) {
      already += 1;
      continue;
    }
    const body = payloads.get(rec.entry_uid);
    // A record whose payload this run did not rebuild predates the interruption
    // that lost its file; it is rebuilt from the database below, and dropped if
    // the entry is gone -- a missing revision file is a gap the peer's reader
    // stops at, which is correct: it will be filled on the next push.
    const rebuilt = body ?? rebuildPayload(db, rec);
    if (!rebuilt) continue;
    const record: SyncRecord = {
      v: SYNC_FORMAT_VERSION,
      device_id: g.device,
      revision: rec.revision,
      base: rec.base,
      entry_uid: rec.entry_uid,
      op: rec.op as 'upsert' | 'delete',
      hash: rec.hash,
      written_at: nowIso(),
      entry: rebuilt.entry,
      tags: rebuilt.tags,
    };
    writeAtomic(file, `${JSON.stringify(record)}\n`);
    written += 1;
  }

  return { ok: true, device_id: g.device, target: g.target, staged: staged.length, written, already };
}

function rebuildPayload(db: DB, rec: RecordRow): { entry: EntryPayload | null; tags: string[] } | null {
  if (rec.op === 'delete') return { entry: null, tags: [] };
  const row = db
    .prepare(`SELECT ${ENTRY_COLUMNS.join(', ')} FROM memory_entries WHERE entry_uid = ?`)
    .get(rec.entry_uid) as EntryPayload | undefined;
  if (!row) return null;
  const tags = (
    db
      .prepare(
        'SELECT tag FROM memory_entry_tags t JOIN memory_entries e ON e.id = t.entry_id WHERE e.entry_uid = ? ORDER BY tag',
      )
      .all(rec.entry_uid) as { tag: string }[]
  ).map((t) => t.tag);
  const entry = Object.fromEntries(ENTRY_COLUMNS.map((c) => [c, row[c] ?? null])) as EntryPayload;
  if (payloadHash('upsert', entry, tags) !== rec.hash) return null;
  return { entry, tags };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/**
 * Reads a record file, or returns null if it is not a whole, self-consistent
 * one.
 *
 * The hash check is the part that matters. A truncated file usually fails
 * `JSON.parse`, but a file a cloud client flushed on a record boundary can be
 * valid JSON and still be the wrong record -- so the payload is re-hashed and
 * compared with the hash the writer put in it.
 */
function readRecord(file: string, device: string, revision: number): SyncRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as SyncRecord;
  if (rec.v !== SYNC_FORMAT_VERSION) return null;
  if (rec.device_id !== device || rec.revision !== revision) return null;
  if (typeof rec.entry_uid !== 'string' || !rec.entry_uid) return null;
  if (rec.op !== 'upsert' && rec.op !== 'delete') return null;
  const tags = Array.isArray(rec.tags) ? rec.tags.filter((t) => typeof t === 'string') : [];
  const entry = rec.op === 'delete' ? null : sanitizeEntry(rec.entry);
  if (rec.op === 'upsert' && !entry) return null;
  if (payloadHash(rec.op, entry, tags) !== rec.hash) return null;
  return { ...rec, entry, tags, base: rec.base ?? null };
}

/**
 * The inbound half of the allowlist. Anything a peer put in the payload that is
 * not a synced column is dropped here rather than reaching a prepared statement
 * -- a future version that starts shipping a field this one does not know about
 * must not have it applied by accident.
 */
function sanitizeEntry(value: unknown): EntryPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || typeof v.project !== 'string') return null;
  return Object.fromEntries(ENTRY_COLUMNS.map((c) => [c, v[c] ?? null])) as EntryPayload;
}

function peerDevices(target: string, local: string): string[] {
  const root = path.join(target, 'devices');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== local)
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function pendingRecordFiles(target: string, device: string, after: number): { revision: number; file: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(deviceDir(target, device));
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{12}\.json$/.test(n))
    .map((n) => ({ revision: Number(n.slice(0, 12)), file: path.join(deviceDir(target, device), n) }))
    .filter((r) => r.revision > after)
    .sort((a, b) => a.revision - b.revision);
}

/**
 * Applies what the peers wrote, one record at a time, in revision order.
 *
 * Each record is applied in its own transaction together with the high-water
 * mark it advances, so an interrupted pull leaves a consistent database and
 * resumes exactly where it stopped. An unreadable record stops that device's
 * stream rather than being skipped past: skipping would advance the mark over a
 * file that is merely still being written, and the record would never be read
 * again.
 */
export function pull(db: DB, config: EklavyaConfig, opts: { target?: string | null } = {}): PullResult {
  const g = guard(db, config, opts.target);
  if (!g.ok) {
    return { ok: false, reason: g.reason, applied: 0, tombstones: 0, skipped: 0, conflicts: 0, stalled: [] };
  }

  let applied = 0;
  let tombstones = 0;
  let skipped = 0;
  let conflicts = 0;
  const stalled: string[] = [];

  for (const device of peerDevices(g.target, g.device)) {
    for (const { revision, file } of pendingRecordFiles(g.target, device, highWater(db, device))) {
      const rec = readRecord(file, device, revision);
      if (!rec) {
        stalled.push(device);
        break;
      }
      const outcome = db.transaction(() => {
        const result = applyRecord(db, rec);
        setHighWater(db, device, revision);
        return result;
      })();
      if (outcome === 'applied') applied += 1;
      else if (outcome === 'tombstone') {
        applied += 1;
        tombstones += 1;
      } else if (outcome === 'conflict') conflicts += 1;
      else skipped += 1;
    }
  }

  return { ok: true, device_id: g.device, target: g.target, applied, tombstones, skipped, conflicts, stalled };
}

type ApplyOutcome = 'applied' | 'tombstone' | 'skipped' | 'conflict';

/**
 * The merge rule, and the only place a remote version reaches local state.
 *
 * `held` is the version this device last agreed on; `local` is what it actually
 * holds now. They come apart when somebody edited here and has not pushed yet,
 * and that gap is the whole point: an unstaged local edit is still a local edit,
 * so comparing the incoming record against `held` alone would let a pull
 * silently overwrite work whose only crime was arriving between two syncs.
 *
 * So: identical content, nothing to do but agree on a name for it. Nothing here
 * yet, or an incoming version that descends from exactly what is held and held
 * is unmodified -- a fast-forward, applied. Anything else is two devices having
 * edited the same entry, which no timestamp can adjudicate: the local version
 * stays live and the incoming one is quarantined whole, for `repairConflict`.
 */
function applyRecord(db: DB, rec: SyncRecord): ApplyOutcome {
  const held = localRecord(db, rec.entry_uid);
  const local = localContent(db, rec.entry_uid);

  if (local && local.hash === rec.hash) {
    // The two devices reached the same content independently. Adopting the
    // incoming version name costs nothing and lines up the next fast-forward.
    settle(db, rec);
    return 'skipped';
  }

  if (held) {
    const dirty = Boolean(local) && local!.hash !== held.hash;
    const fastForward =
      !dirty &&
      (rec.base === ref(held.device_id, held.revision) ||
        (held.device_id === rec.device_id && rec.revision > held.revision));
    if (!dirty && held.device_id === rec.device_id && rec.revision <= held.revision) return 'skipped';
    if (!fastForward) {
      db.prepare(
        `INSERT INTO sync_conflicts (entry_uid, device_id, revision, base, local_ref, payload, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rec.entry_uid,
        rec.device_id,
        rec.revision,
        rec.base,
        ref(held.device_id, held.revision),
        JSON.stringify(rec),
        nowIso(),
      );
      return 'conflict';
    }
  } else if (local) {
    // No agreed version, but content here already: two independent creations
    // under one uid. Rare enough to be suspicious, so it is not merged either.
    db.prepare(
      `INSERT INTO sync_conflicts (entry_uid, device_id, revision, base, local_ref, payload, detected_at)
       VALUES (?, ?, ?, ?, 'local:unstaged', ?, ?)`,
    ).run(rec.entry_uid, rec.device_id, rec.revision, rec.base, JSON.stringify(rec), nowIso());
    return 'conflict';
  }

  const outcome = materialize(db, rec);
  settle(db, rec);
  return outcome;
}

/**
 * Records the version now agreed on, and retires the quarantine it settles --
 * a repair chosen on one device resolves the mirror-image conflict on the other
 * without anybody choosing twice.
 */
function settle(db: DB, rec: SyncRecord): void {
  writeRecord(db, {
    entry_uid: rec.entry_uid,
    device_id: rec.device_id,
    revision: rec.revision,
    base: rec.base,
    op: rec.op,
    hash: rec.hash,
  });
  db.prepare(
    "UPDATE sync_conflicts SET resolved_at = ?, resolution = 'superseded' WHERE entry_uid = ? AND resolved_at IS NULL",
  ).run(nowIso(), rec.entry_uid);
}

/** Writes the entry itself. Memory tables only -- nothing here knows another. */
function materialize(db: DB, rec: SyncRecord): 'applied' | 'tombstone' {
  const existing = db.prepare('SELECT id FROM memory_entries WHERE entry_uid = ?').get(rec.entry_uid) as
    | { id: number }
    | undefined;

  if (rec.op === 'delete') {
    // No local row means the tombstone arrived before the entry ever did, or
    // after it was hard-deleted. The record alone is enough: it is what stops a
    // peer that still holds the entry from putting it back.
    if (existing) deleteEntry(db, existing.id);
    return 'tombstone';
  }

  const entry = rec.entry!;
  const columns = ENTRY_COLUMNS.join(', ');
  const placeholders = ENTRY_COLUMNS.map(() => '?').join(', ');
  const updates = ENTRY_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ');
  db.prepare(
    `INSERT INTO memory_entries (entry_uid, ${columns}, deleted_at) VALUES (?, ${placeholders}, NULL)
     ON CONFLICT(entry_uid) DO UPDATE SET ${updates}, deleted_at = NULL`,
  ).run(rec.entry_uid, ...ENTRY_COLUMNS.map((c) => entry[c] ?? null));

  const id =
    existing?.id ??
    (db.prepare('SELECT id FROM memory_entries WHERE entry_uid = ?').get(rec.entry_uid) as { id: number }).id;

  db.prepare('DELETE FROM memory_entry_tags WHERE entry_id = ?').run(id);
  const tag = db.prepare('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)');
  for (const t of rec.tags) tag.run(id, t.toLowerCase());

  indexVector(
    db,
    id,
    [entry.title, entry.narrative ?? '', entry.facts ?? '', entry.files ?? ''].join('\n'),
  );
  return 'applied';
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface ConflictRow {
  id: number;
  entry_uid: string;
  device_id: string;
  revision: number;
  base: string | null;
  local_ref: string;
  payload: string;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

export function conflicts(db: DB, includeResolved = false): ConflictRow[] {
  const sql = includeResolved
    ? 'SELECT * FROM sync_conflicts ORDER BY id'
    : 'SELECT * FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY id';
  return db.prepare(sql).all() as ConflictRow[];
}

/**
 * Picks a side, and makes the choice travel.
 *
 * Either way the winner is restamped as a **new local revision whose `base` is
 * the quarantined version**. That is what turns one person's decision into
 * convergence: the peer holds exactly that version, so on its next pull the
 * resolution is an ordinary fast-forward rather than a second conflict to
 * adjudicate by hand.
 */
export function repairConflict(db: DB, config: EklavyaConfig, id: number, side: 'local' | 'remote'): boolean {
  const row = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as ConflictRow | undefined;
  if (!row || row.resolved_at) return false;
  const device = deviceId(db, config);
  const rec = JSON.parse(row.payload) as SyncRecord;

  db.transaction(() => {
    if (side === 'remote') materialize(db, rec);
    // Whatever is in the database once the choice is made is what the repair
    // publishes -- read back rather than assumed, because the local side may
    // have been edited again since the conflict was recorded.
    const winner = localContent(db, row.entry_uid) ?? { hash: rec.hash, op: rec.op };
    writeRecord(db, {
      entry_uid: row.entry_uid,
      device_id: device,
      revision: nextRevision(db, device),
      base: ref(rec.device_id, rec.revision),
      op: winner.op,
      hash: winner.hash,
    });
    db.prepare('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?').run(
      nowIso(),
      side,
      id,
    );
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function syncStatus(db: DB, config: EklavyaConfig, opts: { target?: string | null } = {}): SyncStatus {
  const target = resolveTarget(config, opts.target);
  const base: SyncStatus = {
    ok: config.sync.enabled && Boolean(target),
    enabled: config.sync.enabled,
    configured_target: config.sync.target,
    target: target ?? undefined,
    local_revision: 0,
    pending: 0,
    open_conflicts: 0,
    peers: [],
  };
  if (!config.sync.enabled) return { ...base, reason: 'disabled' };
  if (!target) return { ...base, reason: 'no-target' };

  const device = deviceId(db, config);
  const peers = (
    db.prepare('SELECT * FROM sync_state ORDER BY device_id').all() as {
      device_id: string;
      last_revision: number;
      last_sync_at: string | null;
    }[]
  ).filter((p) => p.device_id !== device);

  return {
    ...base,
    device_id: device,
    local_revision: highWater(db, device),
    pending: scanLocal(db).length,
    open_conflicts: conflicts(db).length,
    peers,
  };
}
