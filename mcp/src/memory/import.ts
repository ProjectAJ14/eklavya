import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '../db.js';
import { nowIso } from '../time.js';
import { entryUid, eventUid } from './identity.js';
import { addCandidate, indexVector, insertEntry } from './store.js';

/**
 * The Claude Mem importer (PRD MIG-01/02).
 *
 * Three rules shape everything below, and each one is a failure someone has
 * already had:
 *
 * 1. The source is never written to. It is opened read-only and snapshotted
 *    with `VACUUM INTO`, which folds the WAL in -- a bare file copy of the main
 *    database silently drops every transaction still sitting in the log.
 * 2. Nothing imported is assessed. Observations become `memory_entries`, the
 *    concepts attached to them become `learning_sources` rows with
 *    `status = 'candidate'`, and no attempt, mastery row or gate is touched.
 *    Exposure in another tool's history is not evidence that anything is known.
 * 3. An unrecognised newer source schema stops. Guessing at a layout that moved
 *    produces an import that looks successful and is wrong, which is worse than
 *    one that refuses.
 */

export const IMPORT_SOURCE = 'claude-mem';

/**
 * The newest Claude Mem schema this importer has been read against
 * (`schema_versions` in the source). Anything higher stops rather than guesses;
 * anything lower is imported with whatever columns it has, since the layout has
 * only ever gained columns.
 */
export const SUPPORTED_SCHEMA_VERSION = 52;

/** Tables the importer knows about. Anything else in the source is reported. */
const KNOWN_TABLES = [
  'observations',
  'session_summaries',
  'user_prompts',
  'tool_uses',
  'sdk_sessions',
  'pending_messages',
  'telegram_wrapups',
  'schema_versions',
  'sync_state',
  'sync_outbox',
  'sync_entity_heads',
  'sync_content_outbox',
  'sync_dead_letter',
  'sync_launch_exclusions',
];

export type DispositionKind = 'mapped' | 'dropped' | 'unrecognised';

export interface FieldDisposition {
  table: string;
  field: string;
  /** The Eklavya column it lands in, or null when nothing takes it. */
  to: string | null;
  kind: DispositionKind;
  reason: string;
}

/**
 * The field disposition report (MIG-01). Written out by hand rather than
 * derived, because "which source fields were deliberately dropped, and why" is
 * exactly the thing a derived list cannot say.
 */
const DISPOSITIONS: FieldDisposition[] = [
  // observations -> memory_entries
  m('observations', 'id', 'import_id_map.source_id', 'the resume key; Eklavya ids are its own'),
  m('observations', 'memory_session_id', 'memory_entries.session_id', 'the session the work happened in'),
  m('observations', 'project', 'memory_entries.project', 'kept verbatim as the source named it'),
  m('observations', 'merged_into_project', 'memory_entries.project', 'wins over `project` when set: the source already folded a rename'),
  m('observations', 'type', 'memory_entries.type', ''),
  m('observations', 'title', 'memory_entries.title', ''),
  m('observations', 'subtitle', 'memory_entries.narrative', 'prepended to the narrative; Eklavya has no subtitle column'),
  m('observations', 'narrative', 'memory_entries.narrative', ''),
  m('observations', 'text', 'memory_entries.narrative', 'used when there is no narrative'),
  m('observations', 'facts', 'memory_entries.facts', 'JSON array, carried across as-is'),
  m('observations', 'concepts', "learning_sources (status 'candidate')", 'a proposal, never an accepted concept and never a mastery row'),
  m('observations', 'files_read', 'memory_entries.files', 'unioned with files_modified'),
  m('observations', 'files_modified', 'memory_entries.files', 'unioned with files_read'),
  m('observations', 'created_at_epoch', 'memory_entries.occurred_at', 'the ORIGINAL timestamp; an import is not new work'),
  m('observations', 'created_at', 'memory_entries.occurred_at', 'fallback when the epoch is missing'),
  m('observations', 'generated_by_model', 'memory_entries.generator', 'recorded as the generator, prefixed with the importer'),
  m('observations', 'agent_type', 'memory_entry_tags', 'kept as a tag'),
  d('observations', 'agent_id', 'a foreign run identity with nothing on this machine to join to'),
  d('observations', 'prompt_number', 'an ordering hint inside a source session; occurred_at already orders'),
  d('observations', 'discovery_tokens', "the source's own provider accounting, not a saving Eklavya can attest to"),
  d('observations', 'content_hash', "the source's dedupe key; Eklavya keys on its own deterministic entry_uid"),
  d('observations', 'relevance_count', 'a usage counter for the source ranker, meaningless to a different ranker'),
  d('observations', 'metadata', 'an opaque blob with no agreed shape; importing it would import untyped junk'),
  d('observations', 'synced_at', 'cloud sync state for another installation (MIG-01: no foreign sync metadata into runtime)'),
  d('observations', 'origin_device_id', 'foreign device identity — deliberately never copied into active state'),
  d('observations', 'origin_local_id', 'foreign device identity — deliberately never copied into active state'),
  d('observations', 'sync_rev', 'sync bookkeeping for a service Eklavya does not talk to'),

  // session_summaries -> memory_entries (kind = session_summary)
  m('session_summaries', 'id', 'import_id_map.source_id', 'the resume key'),
  m('session_summaries', 'memory_session_id', 'memory_entries.session_id', ''),
  m('session_summaries', 'project', 'memory_entries.project', ''),
  m('session_summaries', 'merged_into_project', 'memory_entries.project', 'wins over `project` when set'),
  m('session_summaries', 'request', 'memory_entries.title', 'the first line becomes the title, the whole of it a narrative section'),
  m('session_summaries', 'investigated', 'memory_entries.narrative', 'a labelled section'),
  m('session_summaries', 'learned', 'memory_entries.narrative', 'a labelled section'),
  m('session_summaries', 'completed', 'memory_entries.narrative', 'a labelled section'),
  m('session_summaries', 'next_steps', 'memory_entries.narrative', 'a labelled section'),
  m('session_summaries', 'notes', 'memory_entries.narrative', 'a labelled section'),
  m('session_summaries', 'files_read', 'memory_entries.files', 'unioned with files_edited'),
  m('session_summaries', 'files_edited', 'memory_entries.files', 'unioned with files_read'),
  m('session_summaries', 'created_at_epoch', 'memory_entries.occurred_at', 'the ORIGINAL timestamp'),
  m('session_summaries', 'created_at', 'memory_entries.occurred_at', 'fallback when the epoch is missing'),
  d('session_summaries', 'prompt_number', 'an ordering hint; occurred_at already orders'),
  d('session_summaries', 'discovery_tokens', "the source's provider accounting"),
  d('session_summaries', 'synced_at', 'cloud sync state for another installation'),
  d('session_summaries', 'origin_device_id', 'foreign device identity'),
  d('session_summaries', 'origin_local_id', 'foreign device identity'),
  d('session_summaries', 'sync_rev', 'sync bookkeeping'),

  // user_prompts -> evidence_events (kind = prompt)
  m('user_prompts', 'id', 'import_id_map.source_id', 'the resume key'),
  m('user_prompts', 'content_session_id', 'evidence_events.session_id', ''),
  m('user_prompts', 'prompt_text', 'evidence_events.body', ''),
  m('user_prompts', 'prompt_number', 'evidence_events.title', 'rendered as "Prompt #n"'),
  m('user_prompts', 'created_at_epoch', 'evidence_events.occurred_at', 'the ORIGINAL timestamp'),
  m('user_prompts', 'created_at', 'evidence_events.occurred_at', 'fallback when the epoch is missing'),
  m('user_prompts', 'session_db_id', 'evidence_events.project', 'resolved through sdk_sessions; prompts carry no project of their own'),
  d('user_prompts', 'synced_at', 'cloud sync state for another installation'),
  d('user_prompts', 'origin_device_id', 'foreign device identity'),
  d('user_prompts', 'origin_local_id', 'foreign device identity'),
  d('user_prompts', 'sync_rev', 'sync bookkeeping'),

  // tool_uses -> evidence_events (kind = tool_use)
  m('tool_uses', 'id', 'import_id_map.source_id', 'the resume key'),
  m('tool_uses', 'tool_use_id', 'evidence_events.event_uid', 'folded into the deterministic uid'),
  m('tool_uses', 'content_session_id', 'evidence_events.session_id', ''),
  m('tool_uses', 'memory_session_id', 'evidence_events.session_id', 'preferred when present'),
  m('tool_uses', 'project', 'evidence_events.project', ''),
  m('tool_uses', 'tool_name', 'evidence_events.tool', ''),
  m('tool_uses', 'tool_input', 'evidence_events.body', 'with the response, as the recorded turn'),
  m('tool_uses', 'tool_response', 'evidence_events.body', 'with the input, as the recorded turn'),
  m('tool_uses', 'cwd', 'evidence_events.checkout', ''),
  m('tool_uses', 'agent_id', 'evidence_events.agent_id', ''),
  m('tool_uses', 'created_at_epoch', 'evidence_events.occurred_at', 'the ORIGINAL timestamp'),
  m('tool_uses', 'created_at', 'evidence_events.occurred_at', 'fallback when the epoch is missing'),
  d('tool_uses', 'agent_type', 'not modelled on an event; the tool and body already say what ran'),
  d('tool_uses', 'session_db_id', 'an internal source row id with no meaning here'),
  d('tool_uses', 'platform_source', "always 'claude' in practice; Eklavya records host on the event"),
  d('tool_uses', 'prompt_number', 'an ordering hint; occurred_at already orders'),
  d('tool_uses', 'observation_id', 'the link is rebuilt from the id map, not trusted from the source'),
  d('tool_uses', 'or_generation_id', 'provider request correlation for a provider Eklavya did not call'),
  d('tool_uses', 'or_session_id', 'provider request correlation'),
  d('tool_uses', 'content_hash', "the source's dedupe key"),

  // Whole tables that are deliberately not imported.
  d('sdk_sessions', '*', 'read for project and session lookup only; a session is not a row Eklavya stores'),
  d('pending_messages', '*', 'an active worker queue — MIG-01 forbids copying live jobs into runtime state'),
  d('telegram_wrapups', '*', 'delivery state for notifications already sent; importing it could re-send or falsely suppress'),
  d('sync_state', '*', 'cloud sync cursors and credentials-adjacent state for another installation'),
  d('sync_outbox', '*', 'undelivered sync operations belonging to the source install'),
  d('sync_content_outbox', '*', 'undelivered sync payloads belonging to the source install'),
  d('sync_entity_heads', '*', 'foreign device revision heads'),
  d('sync_dead_letter', '*', 'failed sync operations belonging to the source install'),
  d('sync_launch_exclusions', '*', 'sync suppression list belonging to the source install'),
  d('schema_versions', '*', 'read to decide whether this importer understands the source'),
  d('observations_fts', '*', 'a derived index; Eklavya rebuilds its own FTS and vectors on insert'),
];

function m(table: string, field: string, to: string, reason: string): FieldDisposition {
  return { table, field, to, kind: 'mapped', reason };
}
function d(table: string, field: string, reason: string): FieldDisposition {
  return { table, field, to: null, kind: 'dropped', reason };
}

export interface TableCount {
  name: string;
  rows: number;
  known: boolean;
}

export interface Inventory {
  sourcePath: string;
  schemaVersion: number | null;
  supportedMax: number;
  supported: boolean;
  /** Set when `supported` is false: what stopped it and what to do. */
  problem: string | null;
  tables: TableCount[];
  projects: { project: string; entries: number }[];
  dateRange: { from: string | null; to: string | null };
  fields: FieldDisposition[];
}

export interface ImportOptions {
  dryRun?: boolean;
  /** Reuse a snapshot left by an interrupted run rather than taking a new one. */
  resume?: boolean;
  /** Where the snapshot goes. Defaults to a temp directory. */
  snapshotDir?: string;
  /**
   * Source project name -> Eklavya project key.
   *
   * Without this the import is honest but useless at the moment it matters:
   * the source names a project `eklavya` and Eklavya keys projects by the
   * checkout's absolute realpath, so every imported row lands in a project
   * scope that no session ever queries, and a search in the repo the history
   * came from finds nothing. The importer cannot invent the path -- only the
   * person running it knows which checkout `eklavya` meant -- so it is a flag
   * rather than a guess, and the report says which names were mapped and which
   * were left as they were.
   */
  projectMap?: Record<string, string>;
}

/** The four source tables that become Eklavya rows. */
export const IMPORTED_TABLES = ['observations', 'session_summaries', 'user_prompts', 'tool_uses'] as const;
export type ImportedTable = (typeof IMPORTED_TABLES)[number];
export type ImportCounts = Record<ImportedTable, number>;

export interface ImportReport {
  sourcePath: string;
  snapshot: string | null;
  schemaVersion: number | null;
  read: ImportCounts;
  imported: ImportCounts;
  skipped: ImportCounts;
  candidates: number;
  reindexed: number;
  unsupportedFields: FieldDisposition[];
  validation: { ok: boolean; notes: string[] };
  dryRun: boolean;
  /** Source project names that `projectMap` rewrote, and what they became. */
  projectsMapped: { from: string; to: string }[];
  /** Source project names left as they were, so nobody has to guess afterwards. */
  projectsKept: string[];
}

/** Fails with a message that names the next step, never a bare assertion. */
export class ImportError extends Error {}

function openSource(file: string): Database.Database {
  if (!fs.existsSync(file)) {
    throw new ImportError(`No Claude Mem database at ${file}. Pass the path to claude-mem.db (usually ~/.claude-mem/claude-mem.db).`);
  }
  // Read-only is the guarantee, not a precaution: MIG-02 forbids mutating the
  // source, and `readonly` makes that true even if a query below is wrong.
  return new Database(file, { readonly: true, fileMustExist: true });
}

function tableSet(src: Database.Database): Set<string> {
  return new Set(
    (src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
}

function count(src: Database.Database, table: string): number {
  try {
    return (src.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function sourceSchemaVersion(src: Database.Database, tables: Set<string>): number | null {
  if (!tables.has('schema_versions')) return null;
  const row = src.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as { v: number | null };
  return row.v ?? null;
}

/**
 * Epochs in the source are milliseconds, but a fixture or an older row can hold
 * seconds. Distinguishing them by magnitude is safe for any date this century
 * and costs nothing; guessing wrong would file a 2024 observation in 1970.
 */
function isoFromEpoch(epoch: number | null, fallback: string | null): string {
  if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString();
  }
  if (fallback) {
    const parsed = new Date(fallback);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return nowIso();
}

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    /* Not JSON: fall through to the comma split below. */
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** The columns this importer knows, per table, for the unrecognised report. */
const KNOWN_FIELDS = new Map<string, Set<string>>();
for (const disposition of DISPOSITIONS) {
  if (disposition.field === '*') continue;
  const set = KNOWN_FIELDS.get(disposition.table) ?? new Set<string>();
  set.add(disposition.field);
  KNOWN_FIELDS.set(disposition.table, set);
}

function unrecognisedFields(src: Database.Database, tables: Set<string>): FieldDisposition[] {
  const out: FieldDisposition[] = [];
  for (const [table, known] of KNOWN_FIELDS) {
    if (!tables.has(table)) continue;
    const cols = src.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    for (const col of cols) {
      if (known.has(col.name)) continue;
      out.push({
        table,
        field: col.name,
        to: null,
        kind: 'unrecognised',
        reason: 'not present when this importer was written — reported rather than dropped silently',
      });
    }
  }
  return out;
}

/**
 * The read-only dry run (MIG-01). Opens the source read-only, counts, and says
 * what would happen. Nothing here writes to either database.
 */
export function inventory(sourceDb: string): Inventory {
  const src = openSource(sourceDb);
  try {
    const tables = tableSet(src);
    const version = sourceSchemaVersion(src, tables);
    const supported = version === null ? tables.has('observations') : version <= SUPPORTED_SCHEMA_VERSION;
    const problem = supported
      ? null
      : version === null
        ? `${sourceDb} has no observations table and no schema_versions row — it does not look like a Claude Mem database.`
        : newerSchemaMessage(version);

    const names = [...tables].filter((n) => !n.startsWith('sqlite_')).sort();
    const counts: TableCount[] = names.map((name) => ({
      name,
      rows: count(src, name),
      known: KNOWN_TABLES.includes(name) || name.startsWith('observations_fts'),
    }));

    const projects = tables.has('observations')
      ? (src
          .prepare(
            `SELECT COALESCE(merged_into_project, project) AS project, COUNT(*) AS entries
             FROM observations GROUP BY 1 ORDER BY entries DESC`,
          )
          .all() as { project: string; entries: number }[])
      : [];

    const range = tables.has('observations')
      ? (src.prepare('SELECT MIN(created_at_epoch) AS lo, MAX(created_at_epoch) AS hi FROM observations').get() as {
          lo: number | null;
          hi: number | null;
        })
      : { lo: null, hi: null };

    return {
      sourcePath: sourceDb,
      schemaVersion: version,
      supportedMax: SUPPORTED_SCHEMA_VERSION,
      supported,
      problem,
      tables: counts,
      projects,
      dateRange: {
        from: range.lo ? isoFromEpoch(range.lo, null) : null,
        to: range.hi ? isoFromEpoch(range.hi, null) : null,
      },
      fields: [...DISPOSITIONS, ...unrecognisedFields(src, tables)],
    };
  } finally {
    src.close();
  }
}

function newerSchemaMessage(version: number): string {
  return (
    `This Claude Mem database is at schema version ${version}; this importer was written against ${SUPPORTED_SCHEMA_VERSION}. ` +
    'Importing it would mean guessing at columns that have moved, so nothing was read. ' +
    'Upgrade Eklavya, or export from the older Claude Mem version, and run `eklavya memory import --dry-run <path>` again.'
  );
}

/**
 * A stable identity for the source file, so two different Claude Mem databases
 * do not share one id map. The realpath is enough and costs nothing: a restored
 * backup opened from a second location is a second source, which is the
 * conservative answer (it re-imports rather than silently skipping).
 */
function sourceIdentity(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Takes a consistent snapshot including WAL state (MIG-01).
 *
 * `VACUUM INTO` on a read-only connection is the whole trick: it reads through
 * the WAL and writes a single self-consistent file, where `cp claude-mem.db`
 * would hand back a main database missing every transaction still in the log.
 */
function snapshot(sourceDb: string, dir: string, reuse: boolean): string {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'claude-mem-snapshot.db');
  if (reuse && fs.existsSync(out)) return out;
  fs.rmSync(out, { force: true });
  const src = openSource(sourceDb);
  try {
    src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return out;
}

interface Mapped {
  target_id: number;
}

function mapper(db: DB, sourceId: string) {
  const read = db.prepare(
    'SELECT target_id FROM import_id_map WHERE source = ? AND source_db = ? AND source_table = ? AND source_id = ?',
  );
  const write = db.prepare(
    `INSERT OR IGNORE INTO import_id_map
       (source, source_db, source_table, source_id, target_table, target_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    get(table: string, id: number | string): number | null {
      const row = read.get(IMPORT_SOURCE, sourceId, table, String(id)) as Mapped | undefined;
      return row?.target_id ?? null;
    },
    set(table: string, id: number | string, targetTable: string, targetId: number): void {
      write.run(IMPORT_SOURCE, sourceId, table, String(id), targetTable, targetId, nowIso());
    },
  };
}

interface ObservationRow {
  id: number;
  memory_session_id: string | null;
  project: string;
  merged_into_project: string | null;
  text: string | null;
  type: string | null;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at: string | null;
  created_at_epoch: number | null;
  generated_by_model: string | null;
  agent_type: string | null;
}

interface SummaryRow {
  id: number;
  memory_session_id: string | null;
  project: string;
  merged_into_project: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  files_read: string | null;
  files_edited: string | null;
  created_at: string | null;
  created_at_epoch: number | null;
}

interface PromptRow {
  id: number;
  session_db_id: number | null;
  content_session_id: string;
  prompt_number: number | null;
  prompt_text: string;
  created_at: string | null;
  created_at_epoch: number | null;
}

interface ToolUseRow {
  id: number;
  tool_use_id: string;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  agent_id: string | null;
  created_at: string | null;
  created_at_epoch: number | null;
}

const EMPTY_COUNTS = (): ImportCounts => ({
  observations: 0,
  session_summaries: 0,
  user_prompts: 0,
  tool_uses: 0,
});

/**
 * Imports a Claude Mem database into Eklavya's memory tables.
 *
 * Only the memory half is written: `memory_entries`, `evidence_events`,
 * `learning_sources` and `import_id_map`. Concepts, attempts, mastery and gates
 * are never read or written here, which is what makes "an import cannot
 * overwrite learning history" a property of the code rather than a promise.
 */
/** Applies `projectMap`, recording which names were used so the report can say. */
/**
 * Says which source project names were rewritten and which were not.
 *
 * The unmapped list is the useful half: a name left alone is history that will
 * only ever surface under `--all-projects`, and somebody reading the report
 * afterwards should not have to work that out for themselves.
 */
function recordProjects(
  report: ImportReport,
  options: ImportOptions,
  seen: Set<string>,
  used: Set<string>,
): void {
  const map = options.projectMap ?? {};
  report.projectsMapped = [...used].sort().map((from) => ({ from, to: map[from]! }));
  report.projectsKept = [...seen].filter((name) => !used.has(name)).sort();
}

function projectMapper(options: ImportOptions, used: Set<string>): (name: string) => string {
  const map = options.projectMap ?? {};
  return (name: string) => {
    const mapped = map[name];
    if (mapped === undefined) return name;
    used.add(name);
    return mapped;
  };
}

export function importFrom(db: DB, sourceDb: string, opts: ImportOptions = {}): ImportReport {
  const dryRun = opts.dryRun ?? false;
  const found = inventory(sourceDb);
  if (!found.supported) throw new ImportError(found.problem ?? 'Unsupported source database.');

  const read = EMPTY_COUNTS();
  for (const table of IMPORTED_TABLES) {
    read[table] = found.tables.find((t) => t.name === table)?.rows ?? 0;
  }

  const mapped = new Set<string>();
  const toProject = projectMapper(opts, mapped);
  const seenProjects = new Set<string>();
  const projectOf = (name: string): string => {
    seenProjects.add(name);
    return toProject(name);
  };

  const report: ImportReport = {
    sourcePath: sourceDb,
    snapshot: null,
    schemaVersion: found.schemaVersion,
    read,
    imported: EMPTY_COUNTS(),
    skipped: EMPTY_COUNTS(),
    candidates: 0,
    reindexed: 0,
    unsupportedFields: found.fields.filter((f) => f.kind !== 'mapped'),
    validation: { ok: true, notes: [] },
    dryRun,
    projectsMapped: [],
    projectsKept: [],
  };
  if (dryRun) {
    // A dry run reads nothing project-shaped, so the mapping it would apply is
    // reported from the inventory instead of from rows it never touched.
    recordProjects(report, opts, new Set(found.projects.map((p) => p.project)), mapped);
    return report;
  }

  const dir = opts.snapshotDir ?? path.join(os.tmpdir(), 'eklavya-import');
  const snap = snapshot(sourceDb, dir, opts.resume ?? false);
  report.snapshot = snap;

  const src = new Database(snap, { readonly: true, fileMustExist: true });
  try {
    const tables = tableSet(src);
    const ids = mapper(db, sourceIdentity(sourceDb));
    const entryIds: number[] = [];

    // sdk_sessions is read for lookup only — a prompt carries no project of its
    // own, and filing it under the wrong repository is worse than not importing
    // it at all.
    const sessionProject = new Map<number, { project: string; sessionId: string }>();
    if (tables.has('sdk_sessions')) {
      for (const row of src
        .prepare('SELECT id, project, content_session_id, memory_session_id FROM sdk_sessions')
        .all() as { id: number; project: string; content_session_id: string; memory_session_id: string | null }[]) {
        sessionProject.set(row.id, {
          project: projectOf(row.project),
          sessionId: row.memory_session_id ?? row.content_session_id,
        });
      }
    }

    if (tables.has('observations')) {
      for (const row of src.prepare('SELECT * FROM observations ORDER BY id').iterate() as Iterable<ObservationRow>) {
        if (ids.get('observations', row.id) !== null) {
          report.skipped.observations++;
          continue;
        }
        const occurredAt = isoFromEpoch(row.created_at_epoch, row.created_at);
        const entryProject = projectOf(row.merged_into_project ?? row.project);
        const title = (row.title ?? row.subtitle ?? row.text ?? 'Imported observation').slice(0, 200);
        const narrative = [row.subtitle, row.narrative ?? row.text].filter(Boolean).join('\n\n');
        const concepts = jsonArray(row.concepts);
        const files = [...new Set([...jsonArray(row.files_read), ...jsonArray(row.files_modified)])];

        const entryId = db.transaction(() => {
          const id = insertEntry(db, {
            project: entryProject,
            sessionId: row.memory_session_id,
            kind: 'observation',
            type: row.type,
            title,
            narrative,
            facts: jsonArray(row.facts),
            files,
            tags: [...concepts.map((c) => c.toLowerCase()), ...(row.agent_type ? [row.agent_type.toLowerCase()] : [])],
            generator: row.generated_by_model ? `${IMPORT_SOURCE}:${row.generated_by_model}` : IMPORT_SOURCE,
            occurredAt,
            importSource: IMPORT_SOURCE,
            entryUid: entryUid({ project: entryProject, title, occurredAt, salt: `${IMPORT_SOURCE}:observations:${row.id}` }),
          });
          ids.set('observations', row.id, 'memory_entries', id);
          // A concept the source attached is a *proposal*. It lands as a
          // candidate and nothing more: no mastery, no attempt, no gate.
          for (const concept of concepts) {
            const slug = slugify(concept);
            if (!slug) continue;
            addCandidate(db, {
              entryId: id,
              slug,
              name: concept,
              domain: 'imported',
              confidence: 0,
              project: entryProject,
            });
            report.candidates++;
          }
          return id;
        })();

        entryIds.push(entryId);
        report.imported.observations++;
      }
    }

    if (tables.has('session_summaries')) {
      for (const row of src
        .prepare('SELECT * FROM session_summaries ORDER BY id')
        .iterate() as Iterable<SummaryRow>) {
        if (ids.get('session_summaries', row.id) !== null) {
          report.skipped.session_summaries++;
          continue;
        }
        const occurredAt = isoFromEpoch(row.created_at_epoch, row.created_at);
        const entryProject = projectOf(row.merged_into_project ?? row.project);
        const title = (row.request?.split('\n')[0] ?? 'Session summary').slice(0, 200);
        const narrative = (
          [
            ['Request', row.request],
            ['Investigated', row.investigated],
            ['Learned', row.learned],
            ['Completed', row.completed],
            ['Next steps', row.next_steps],
            ['Notes', row.notes],
          ] as const
        )
          .filter(([, value]) => Boolean(value))
          .map(([label, value]) => `${label}: ${value}`)
          .join('\n\n');

        const id = insertEntry(db, {
          project: entryProject,
          sessionId: row.memory_session_id,
          kind: 'session_summary',
          title,
          narrative,
          files: [...new Set([...jsonArray(row.files_read), ...jsonArray(row.files_edited)])],
          generator: IMPORT_SOURCE,
          occurredAt,
          importSource: IMPORT_SOURCE,
          entryUid: entryUid({ project: entryProject, title, occurredAt, salt: `${IMPORT_SOURCE}:session_summaries:${row.id}` }),
        });
        ids.set('session_summaries', row.id, 'memory_entries', id);
        entryIds.push(id);
        report.imported.session_summaries++;
      }
    }

    if (tables.has('user_prompts')) {
      for (const row of src.prepare('SELECT * FROM user_prompts ORDER BY id').iterate() as Iterable<PromptRow>) {
        if (ids.get('user_prompts', row.id) !== null) {
          report.skipped.user_prompts++;
          continue;
        }
        const occurredAt = isoFromEpoch(row.created_at_epoch, row.created_at);
        const session = row.session_db_id === null ? undefined : sessionProject.get(row.session_db_id);
        const id = appendImportedEvent(db, {
          project: session?.project ?? 'unknown',
          sessionId: session?.sessionId ?? row.content_session_id,
          kind: 'prompt',
          title: row.prompt_number === null ? null : `Prompt #${row.prompt_number}`,
          body: row.prompt_text,
          occurredAt,
        });
        ids.set('user_prompts', row.id, 'evidence_events', id);
        report.imported.user_prompts++;
      }
    }

    if (tables.has('tool_uses')) {
      for (const row of src.prepare('SELECT * FROM tool_uses ORDER BY id').iterate() as Iterable<ToolUseRow>) {
        if (ids.get('tool_uses', row.id) !== null) {
          report.skipped.tool_uses++;
          continue;
        }
        const occurredAt = isoFromEpoch(row.created_at_epoch, row.created_at);
        const body = [row.tool_input, row.tool_response].filter(Boolean).join('\n---\n');
        const id = appendImportedEvent(db, {
          project: projectOf(row.project),
          checkout: row.cwd,
          sessionId: row.memory_session_id ?? row.content_session_id,
          agentId: row.agent_id,
          kind: 'tool_use',
          tool: row.tool_name,
          title: row.tool_name,
          body: `${row.tool_use_id}\n${body}`,
          occurredAt,
        });
        ids.set('tool_uses', row.id, 'evidence_events', id);
        report.imported.tool_uses++;
      }
    }

    // Rebuild the vectors for everything imported (MIG-02). `insertEntry`
    // indexes as it goes, so this is a backstop for a run resumed after a crash
    // between the insert and its vector -- and it is what makes "the index was
    // rebuilt" a checked fact rather than an assumption.
    report.reindexed = reindex(db, entryIds);

    report.validation = validate(db, report);
    recordProjects(report, opts, seenProjects, mapped);
    return report;
  } finally {
    src.close();
    // The snapshot is a complete copy of the developer's history. It exists so
    // an interrupted run can resume; once the run has validated there is no
    // reason to leave one sitting in a temp directory (PRD SEC-02).
    if (report.validation.ok) fs.rmSync(snap, { force: true });
  }
}

function appendImportedEvent(
  db: DB,
  input: {
    project: string;
    checkout?: string | null;
    sessionId: string;
    agentId?: string | null;
    kind: string;
    tool?: string | null;
    title?: string | null;
    body: string;
    occurredAt: string;
  },
): number {
  // `host: 'claude-mem'` and `source: 'import'` together are the provenance: an
  // imported event must never be mistaken for something this machine watched.
  const uid = eventUid({
    host: IMPORT_SOURCE,
    sessionId: input.sessionId,
    agentId: input.agentId ?? null,
    kind: input.kind,
    tool: input.tool ?? null,
    occurredAt: input.occurredAt,
    body: input.body,
  });
  const existing = db.prepare('SELECT id FROM evidence_events WHERE event_uid = ?').get(uid) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  return Number(
    db
      .prepare(
        `INSERT INTO evidence_events
           (event_uid, project, checkout, session_id, agent_id, host, source, kind, tool,
            title, body, files, occurred_at, received_at, redacted, status)
         VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, NULL, ?, ?, 0, 'summarized')`,
      )
      .run(
        uid,
        input.project,
        input.checkout ?? null,
        input.sessionId,
        input.agentId ?? null,
        IMPORT_SOURCE,
        input.kind,
        input.tool ?? null,
        input.title ?? null,
        input.body,
        input.occurredAt,
        nowIso(),
      ).lastInsertRowid,
  );
}

function reindex(db: DB, entryIds: number[]): number {
  let done = 0;
  const get = db.prepare('SELECT title, narrative, facts, files FROM memory_entries WHERE id = ?');
  for (const id of entryIds) {
    const row = get.get(id) as
      | { title: string; narrative: string; facts: string | null; files: string | null }
      | undefined;
    if (!row) continue;
    indexVector(db, id, [row.title, row.narrative, row.facts ?? '', row.files ?? ''].join('\n'));
    done++;
  }
  return done;
}

/**
 * Count validation (MIG-02). Every source row must be accounted for as either
 * imported or already present; anything else means rows were dropped silently,
 * which is the failure mode an import report exists to catch.
 */
function validate(db: DB, report: ImportReport): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  for (const table of IMPORTED_TABLES) {
    const seen = report.imported[table] + report.skipped[table];
    if (seen !== report.read[table]) {
      notes.push(`${table}: read ${report.read[table]}, accounted for ${seen}`);
    }
  }
  const vectorless = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_entries e
         WHERE e.import_source IS NOT NULL AND e.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.entry_id = e.id)`,
      )
      .get() as { n: number }
  ).n;
  if (vectorless > 0) notes.push(`${vectorless} imported entries have no vector`);
  return { ok: notes.length === 0, notes };
}

/**
 * The export format version `eklavya memory export` stamps and
 * `restoreExport` refuses to guess past. Bump it when the payload shape below
 * changes.
 */
export const EXPORT_SCHEMA_VERSION = 1;

export interface RestoreReport {
  file: string;
  schemaVersion: number;
  entries: { restored: number; skipped: number };
  evidence: { restored: number; skipped: number };
  receipts: { restored: number; skipped: number };
  tags: number;
  links: number;
  receiptItems: number;
  reindexed: number;
}

type Row = Record<string, unknown>;

/** Columns are listed rather than spread: an export carries ids and a
 *  `batch_id` that mean nothing in the destination database, and binding them
 *  would either collide with a live row or point a foreign key at nothing. */
const EVENT_COLUMNS = [
  'event_uid', 'project', 'checkout', 'session_id', 'agent_id', 'host', 'source', 'kind', 'tool',
  'title', 'body', 'files', 'occurred_at', 'received_at', 'redacted', 'status',
];
const ENTRY_COLUMNS = [
  'entry_uid', 'project', 'session_id', 'kind', 'type', 'title', 'narrative', 'facts', 'files',
  'generator', 'confidence', 'occurred_at', 'created_at', 'deleted_at', 'import_source',
];
const RECEIPT_COLUMNS = [
  'receipt_uid', 'project', 'session_id', 'scope', 'method', 'base_tokens', 'delivered_tokens',
  'item_count', 'delivery', 'created_at',
];

function values(row: Row, columns: string[]): unknown[] {
  return columns.map((c) => row[c] ?? null);
}

function rows(payload: Row, key: string): Row[] {
  const value = payload[key];
  return Array.isArray(value) ? (value as Row[]) : [];
}

/**
 * Restores a `eklavya memory export` file (the other half of the backup pair).
 *
 * Shares the importer's three rules next door, because the invariants are the
 * same: nothing outside the memory tables is written, so attempts, mastery and
 * gates are untouched; a schema version this build does not know stops with
 * both versions named rather than guessing; and identity is the `*_uid`
 * columns, so a second restore of the same file adds nothing.
 *
 * Ids are remapped rather than reused. An export's primary keys belong to the
 * database it came from, and the destination may already have rows at those
 * numbers — restoring them verbatim would either collide or, worse, silently
 * attach one machine's evidence to another machine's observation.
 */
export function restoreExport(db: DB, file: string): RestoreReport {
  if (!fs.existsSync(file)) {
    throw new ImportError(`No export file at ${file}. Pass the file \`eklavya memory export\` wrote.`);
  }

  let payload: Row;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8')) as Row;
  } catch {
    throw new ImportError(`${file} is not readable JSON. Pass the file \`eklavya memory export\` wrote.`);
  }

  const found = payload?.schema_version;
  if (found !== EXPORT_SCHEMA_VERSION) {
    throw new ImportError(
      `${file} is export schema version ${found === undefined ? 'unstated' : String(found)}; ` +
        `this build understands version ${EXPORT_SCHEMA_VERSION}. ` +
        'Restore it with the Eklavya version that wrote it, or export again from that version.',
    );
  }

  const report: RestoreReport = {
    file,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    entries: { restored: 0, skipped: 0 },
    evidence: { restored: 0, skipped: 0 },
    receipts: { restored: 0, skipped: 0 },
    tags: 0,
    links: 0,
    receiptItems: 0,
    reindexed: 0,
  };
  const restoredEntryIds: number[] = [];

  db.transaction(() => {
    const insert = (table: string, columns: string[]) =>
      db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      );

    // Evidence first: entries link to it, and the link table needs both sides
    // mapped before it can be written.
    const eventIds = new Map<number, number>();
    const findEvent = db.prepare('SELECT id FROM evidence_events WHERE event_uid = ?');
    const insEvent = insert('evidence_events', EVENT_COLUMNS);
    for (const row of rows(payload, 'evidence')) {
      const existing = findEvent.get(row.event_uid) as { id: number } | undefined;
      if (existing) {
        eventIds.set(Number(row.id), existing.id);
        report.evidence.skipped++;
        continue;
      }
      eventIds.set(Number(row.id), Number(insEvent.run(...values(row, EVENT_COLUMNS)).lastInsertRowid));
      report.evidence.restored++;
    }

    const entryIds = new Map<number, number>();
    const findEntry = db.prepare('SELECT id FROM memory_entries WHERE entry_uid = ?');
    const insEntry = insert('memory_entries', ENTRY_COLUMNS);
    for (const row of rows(payload, 'entries')) {
      const existing = findEntry.get(row.entry_uid) as { id: number } | undefined;
      if (existing) {
        entryIds.set(Number(row.id), existing.id);
        report.entries.skipped++;
        continue;
      }
      const id = Number(insEntry.run(...values(row, ENTRY_COLUMNS)).lastInsertRowid);
      entryIds.set(Number(row.id), id);
      restoredEntryIds.push(id);
      report.entries.restored++;
    }

    // Second pass, because a correction can supersede a row that had not been
    // inserted yet when its own turn came.
    const supersede = db.prepare('UPDATE memory_entries SET superseded_by = ? WHERE id = ?');
    for (const row of rows(payload, 'entries')) {
      const target = entryIds.get(Number(row.superseded_by));
      const self = entryIds.get(Number(row.id));
      if (row.superseded_by != null && target && self) supersede.run(target, self);
    }

    const insTag = db.prepare('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)');
    for (const row of rows(payload, 'tags')) {
      const entryId = entryIds.get(Number(row.entry_id));
      if (entryId) report.tags += insTag.run(entryId, row.tag).changes;
    }

    const insLink = db.prepare('INSERT OR IGNORE INTO memory_entry_events (entry_id, event_id) VALUES (?, ?)');
    for (const row of rows(payload, 'entry_events')) {
      const entryId = entryIds.get(Number(row.entry_id));
      const eventId = eventIds.get(Number(row.event_id));
      if (entryId && eventId) report.links += insLink.run(entryId, eventId).changes;
    }

    const receiptIds = new Map<number, number>();
    const findReceipt = db.prepare('SELECT id FROM context_receipts WHERE receipt_uid = ?');
    const insReceipt = insert('context_receipts', RECEIPT_COLUMNS);
    for (const row of rows(payload, 'receipts')) {
      const existing = findReceipt.get(row.receipt_uid) as { id: number } | undefined;
      if (existing) {
        receiptIds.set(Number(row.id), existing.id);
        report.receipts.skipped++;
        continue;
      }
      receiptIds.set(Number(row.id), Number(insReceipt.run(...values(row, RECEIPT_COLUMNS)).lastInsertRowid));
      report.receipts.restored++;
    }

    const insItem = db.prepare(
      `INSERT OR IGNORE INTO context_receipt_items (receipt_id, entry_id, source_tokens, sent_tokens, stage)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of rows(payload, 'receipt_items')) {
      const receiptId = receiptIds.get(Number(row.receipt_id));
      const entryId = entryIds.get(Number(row.entry_id));
      if (receiptId && entryId) {
        report.receiptItems += insItem.run(
          receiptId, entryId, row.source_tokens ?? 0, row.sent_tokens ?? 0, row.stage ?? 'index',
        ).changes;
      }
    }

    // FTS keeps itself in step through the insert trigger; the vectors do not,
    // so a restore without this is a restore nothing can find semantically.
    report.reindexed = reindex(db, restoredEntryIds);
  })();

  return report;
}

/**
 * The payload `eklavya memory export` writes and `restoreExport` reads.
 *
 * Here rather than in the CLI so the two halves of the backup pair cannot
 * drift: a column added to the export and not to the restore is a column that
 * silently does not survive a round trip.
 */
export function exportPayload(db: DB): Row {
  const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: nowIso(),
    db_schema_version: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined)?.value,
    entries: all('SELECT * FROM memory_entries ORDER BY id'),
    tags: all('SELECT * FROM memory_entry_tags ORDER BY entry_id, tag'),
    entry_events: all('SELECT * FROM memory_entry_events ORDER BY entry_id, event_id'),
    evidence: all('SELECT * FROM evidence_events ORDER BY id'),
    receipts: all('SELECT * FROM context_receipts ORDER BY id'),
    receipt_items: all('SELECT * FROM context_receipt_items ORDER BY receipt_id, entry_id, stage'),
  };
}
