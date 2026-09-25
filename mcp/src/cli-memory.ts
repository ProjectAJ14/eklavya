/**
 * `eklavya memory …` — the memory half of the CLI, moved out of `cli.ts`.
 *
 * Its own module so that `cli.ts` can load it only when a memory subcommand
 * (or `doctor`, for `workerLine`) runs: this is where the worker, sync, replay,
 * search and the Claude Mem importer come in, and `eklavya statusline` runs on
 * every status-bar refresh without needing any of them. A pure move — the
 * output and exit codes are the ones `cli.ts` had.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type DB } from './db.js';
import { dbPath } from './paths.js';
import { loadConfig, findRepoConfig } from './config.js';
import { projectKey } from './store.js';
import { claudeHome } from './install.js';
import { guessProjectMap } from './claude-mem.js';
import { spin } from './theme.js';
import { importOffThread } from './memory/import-worker.js';
import { isInternalObserver, releaseWorker, renewWorker, reserveWorker, stopWorker, workerStatus } from './memory/reservation.js';
import { identityFor } from './memory/identity.js';
import {
  backlogSummary,
  countEntries,
  discardBacklog,
  entryById,
  entryEvents,
  entryTags,
  pendingEventCount,
  quarantineBacklog,
  receiptTotals,
  restoreBacklog,
  resumePaused,
  timeline,
  type BacklogSelector,
} from './memory/store.js';
import { search, type SearchMode } from './memory/search.js';
import { pull, push, syncStatus } from './memory/sync.js';
import { pruneEvidence, queueDepth, resumeIfRepaired, summarizerFor, superviseWorker } from './memory/worker.js';
import { replayProject, transcriptDirFor, transcriptsFor } from './memory/replay.js';
import { droppedCount } from './memory/spool.js';
import { savingsFrom, savingsLine } from './memory/tokens.js';
import {
  inventory,
  exportPayload,
  restoreExport,
  EXPORT_SCHEMA_VERSION,
  ImportError,
  IMPORTED_TABLES,
  verifyImport,
  type VerifyReport,
  type FieldDisposition,
} from './memory/import.js';

/** The same as `cli.ts`'s: importing that one would run its `main()`. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * `eklavya memory <subcommand>` — the memory half, outside a session.
 *
 * Project-scoped by default on every read, like the retrieval layer it sits on:
 * another repository's work is noise, and `--all-projects` is the explicit way
 * to ask for it.
 */
const MEMORY_USAGE =
  'Usage: eklavya memory status|search|timeline|show|replay|process|stop|backlog|prune|import|export|restore|sync\n' +
  '       run `eklavya --help` for the full list\n';

function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value.`);
  return value;
}

function numberFlag(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} needs a positive number.`);
  return Math.floor(n);
}

/** The project key the memory tables use — the same one the hooks record under. */
function currentProject(): string {
  return identityFor({ cwd: process.cwd(), sessionId: 'cli' }).project;
}

/**
 * How a migration is checked: what arrived here, and what arrived under a
 * Claude Mem project name no checkout matches -- history that only surfaces
 * under --all-projects until it is placed.
 */
function importedLines(db: DB, project: string): string[] {
  const rows = db
    .prepare(
      `SELECT project, COUNT(*) AS n FROM memory_entries
       WHERE import_source IS NOT NULL AND deleted_at IS NULL GROUP BY project`,
    )
    .all() as { project: string; n: number }[];
  if (!rows.length) return [];
  const here = rows.find((r) => r.project === project)?.n ?? 0;
  const bare = rows.filter((r) => !path.isAbsolute(r.project));
  const unplaced = bare.reduce((sum, r) => sum + r.n, 0);
  return [
    `imported:   ${here} here from Claude Mem`,
    ...(unplaced
      ? [
          `unplaced:   ${unplaced} under ${bare.length} name(s) no checkout matches — ${bare.map((r) => r.project).slice(0, 5).join(', ')}${bare.length > 5 ? ', …' : ''}`,
          '            place them: eklavya memory import ~/.claude-mem.retired/claude-mem.db [--map <name>=<checkout>]',
        ]
      : []),
  ];
}

/** "2m 05s" — elapsed since an ISO stamp. */
function since(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '?';
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/** The one background worker, or that there is none — for `memory status` and `doctor`. */
export function workerLine(db: DB): string {
  const w = workerStatus(db);
  if (!w) return 'none running';
  return [
    w.pid ? `pid ${w.pid}` : 'starting',
    w.started ? `up ${since(w.started)}` : null,
    w.generation ? `hand-off ${w.generation}` : null,
    w.child ? `claude pid ${w.child}` : null,
    w.job ? `job #${w.job} for ${since(w.jobStarted)}` : null,
    w.stale ? `STALE — no heartbeat for ${since(w.heartbeat)}, being stopped` : `heartbeat ${since(w.heartbeat)} ago`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Why the queue is paused, by class — never `last_error`, which is the
 * provider's own prose and has carried a URL with a token in it.
 */
function pauseLine(db: DB): string | null {
  const rows = db
    .prepare(
      `SELECT error_class, COUNT(*) AS n, MAX(updated_at) AS at FROM memory_jobs
       WHERE status = 'paused' GROUP BY error_class ORDER BY at DESC`,
    )
    .all() as { error_class: string | null; n: number; at: string }[];
  if (!rows.length) return null;
  const why: Record<string, string> = {
    auth: 'claude is not logged in',
    quota: 'usage limit reached',
    missing: 'claude is not on the PATH',
  };
  return rows
    .map((r) => `${r.n} on ${r.error_class ?? 'unclassified'}${why[r.error_class ?? ''] ? ` (${why[r.error_class!]})` : ''}, since ${r.at}`)
    .join('; ');
}

function memoryStatus(): void {
  const db = openDb();
  try {
    const { config } = loadConfig();
    const project = currentProject();
    const queue = queueDepth(db);
    const totals = receiptTotals(db);
    const savings = savingsFrom({
      baseTokens: totals.base,
      deliveredTokens: totals.delivered,
      delivery: totals.confirmed > 0 ? 'confirmed' : 'unknown',
    });

    const lines = [
      `project:    ${project}`,
      `capture:    ${config.memory.enabled ? config.memory.capture : 'off (memory.enabled is false)'}`,
      `entries:    ${countEntries(db, project)} here, ${countEntries(db)} in total`,
      ...importedLines(db, project),
      `pending:    ${pendingEventCount(db, project)} evidence events here, ${pendingEventCount(db)} in total`,
      `queue:      ${queue.pending} pending · ${queue.paused} paused · ${queue.failed} failed${
        queue.quarantined ? ` · ${queue.quarantined} quarantined` : ''
      }`,
      `oldest job: ${queue.oldest ?? '—'}`,
      ...(pauseLine(db) ? [`paused:     ${pauseLine(db)} — fix it, then: eklavya memory process`] : []),
      `worker:     ${workerLine(db)}`,
      // Named separately from the summarizer because they answer different
      // questions: one is "will anything leave this machine", the other is
      // "what is actually writing the observations right now".
      `provider:   ${
        config.providers.observer
          ? `${config.providers.observer.kind}:${config.providers.observer.model} (via claude -p, on your subscription)`
          : 'none — nothing leaves this machine'
      }`,
      `summarizer: ${summarizerFor(config).id}`,
      `spool drops: ${droppedCount()}`,
      `receipts:   ${totals.receipts} (${totals.confirmed} confirmed) · base ${totals.base} → delivered ${totals.delivered} tokens`,
      savingsLine(savings),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    db.close();
  }
}

function memorySearch(argv: string[]): void {
  const query = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.match(/^--(mode|limit)$/)).join(' ');
  if (!query.trim()) fail('Usage: eklavya memory search <query> [--mode keyword|semantic|hybrid] [--limit <n>] [--all-projects]');

  const { config } = loadConfig();
  const mode = (flag(argv, '--mode', config.retrieval.mode) ?? 'hybrid') as SearchMode;
  if (mode !== 'keyword' && mode !== 'semantic' && mode !== 'hybrid') {
    fail('--mode must be keyword, semantic or hybrid.');
  }

  const db = openDb();
  try {
    const hits = search(db, query, mode, {
      project: currentProject(),
      allProjects: argv.includes('--all-projects'),
      limit: numberFlag(argv, '--limit', 10),
    });
    if (!hits.length) {
      process.stdout.write('No matches.\n');
      return;
    }
    for (const hit of hits) {
      process.stdout.write(
        `#${hit.entry.id}  ${hit.entry.occurred_at.slice(0, 16).replace('T', ' ')}  ${hit.entry.title}\n` +
          `     ${hit.entry.type ?? hit.entry.kind} · score ${hit.score.toFixed(3)} · ${hit.via}${
            hit.entry.import_source ? ` · imported from ${hit.entry.import_source}` : ''
          }\n`,
      );
    }
  } finally {
    db.close();
  }
}

function memoryTimeline(argv: string[]): void {
  const db = openDb();
  try {
    const rows = timeline(db, {
      project: currentProject(),
      limit: numberFlag(argv, '--limit', 20),
      since: flag(argv, '--since') ?? null,
    });
    if (!rows.length) {
      process.stdout.write('Nothing recorded for this project yet.\n');
      return;
    }
    for (const row of rows) {
      process.stdout.write(
        `#${row.id}  ${row.occurred_at.slice(0, 16).replace('T', ' ')}  ${row.kind}  ${row.title}\n`,
      );
    }
  } finally {
    db.close();
  }
}

function memoryShow(argv: string[]): void {
  const id = Number(argv[0]);
  if (!Number.isInteger(id)) fail('Usage: eklavya memory show <id>');

  const db = openDb();
  try {
    const entry = entryById(db, id);
    if (!entry) fail(`No memory entry #${id}.`);

    const tags = entryTags(db, id);
    const lines = [
      `#${entry.id}  ${entry.title}`,
      `kind:      ${entry.kind}${entry.type ? ` / ${entry.type}` : ''}`,
      `project:   ${entry.project}`,
      `occurred:  ${entry.occurred_at}`,
      `generator: ${entry.generator}`,
      ...(entry.import_source ? [`imported:  from ${entry.import_source} (unassessed — no mastery, no attempts)`] : []),
      ...(entry.superseded_by ? [`superseded by #${entry.superseded_by}`] : []),
      ...(tags.length ? [`tags:      ${tags.join(', ')}`] : []),
      ...(entry.files ? [`files:     ${(JSON.parse(entry.files) as string[]).join(', ')}`] : []),
      '',
      entry.narrative || '(no narrative)',
    ];

    const facts = entry.facts ? (JSON.parse(entry.facts) as string[]) : [];
    if (facts.length) lines.push('', 'Facts:', ...facts.map((f) => `  - ${f}`));

    const events = entryEvents(db, id);
    lines.push('', `Evidence (${events.length}):`);
    for (const event of events) {
      lines.push(
        `  ${event.occurred_at.slice(0, 16).replace('T', ' ')}  ${event.kind}${
          event.tool ? `/${event.tool}` : ''
        }  ${event.body.slice(0, 120).replace(/\s+/g, ' ')}`,
      );
    }
    if (!events.length) lines.push('  (none linked — imported or hand-written entries carry no local evidence)');

    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    db.close();
  }
}

function memoryProcess(argv: string[]): void {
  // A summariser's own session must never start a worker: that is the loop
  // that took 165 of them to stop (`reservation.ts`).
  if (isInternalObserver()) return;
  const db = openDb();
  const { config } = loadConfig();
  // Running this command *is* the "I have fixed the credential" signal: it is
  // what `doctor` tells the developer to run. The only other way off 'paused'
  // is `--probe-paused`, which resumes only with proof the cause is fixed — a
  // hook that resumed without it would spend a rejected key every session.
  // Validate before resuming. `numberFlag` exits on a bad value, and resuming
  // is not undoable: a refused run that had already emptied the pause would
  // tell the developer nothing happened while the queue quietly went back to
  // spending a credential that may still be rejected.
  const maxJobs = numberFlag(argv, '--max', 10);
  // `--probe-paused` is the hooks' paused-queue check: background like
  // `--no-resume`, but it resumes once `resumeIfRepaired` proves the cause fixed.
  const probe = argv.includes('--probe-paused');
  const background = argv.includes('--no-resume') || probe;

  // One worker per installation, manual runs included. A hook that spawned us
  // already won the slot and hands over its token; anyone else competes for it.
  const handed = flag(argv, '--worker-token');
  let token: string | null;
  try {
    token = handed
      ? renewWorker(db, handed, { pid: process.pid })
        ? handed
        : null
      : reserveWorker(db, process.pid);
  } catch {
    // A database too busy to reserve in is one to leave alone: the slot, if
    // this launch held it, lapses on its own.
    token = null;
  }
  if (!token) {
    const holder = workerStatus(db);
    if (!background) {
      process.stdout.write(
        `another memory worker is running${holder?.pid ? ` (pid ${holder.pid})` : ''} — its queue is this queue, so nothing to do.\n`,
      );
    }
    db.close();
    return;
  }

  // The hooks' background drain passes --no-resume: a hook that resumed
  // without proof is exactly the retry loop the comment above rules out. The
  // probe resumes with proof, or releases the slot and exits unspent.
  if (probe) {
    const held = token;
    const giveUp = () => {
      releaseWorker(db, held);
      db.close();
    };
    resumeIfRepaired(db).then((moved) => (moved ? runWorker(db, held, config, maxJobs, true, moved) : giveUp()), giveUp);
    return;
  }
  const resumed = background ? 0 : resumePaused(db);
  runWorker(db, token, config, maxJobs, background, resumed);
}

function runWorker(
  db: ReturnType<typeof openDb>,
  token: string,
  config: ReturnType<typeof loadConfig>['config'],
  maxJobs: number,
  background: boolean,
  resumed: number,
): void {
  // SIGHUP too: a closed terminal is a stop, and the call it left running is
  // exactly the orphan this has to prevent.
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, onSignal);

  superviseWorker(db, token, config, {
    maxJobs,
    signal: stop.signal,
    loadConfig: () => loadConfig().config,
  }).then(
    (result) => {
      if (!background) {
        process.stdout.write(
          `${resumed ? `resumed ${resumed} paused · ` : ''}processed ${result.processed} · entries ${result.entries} · failed ${result.failed} · skipped ${result.skipped}${
            result.handedOff ? ' · more queued, continuing in the background' : ''
          }\n`,
        );
      }
      db.close();
    },
    (err: Error) => {
      db.close();
      fail(`eklavya memory process: ${err.message}`);
    },
  );
}

/**
 * `eklavya memory backlog [quarantine|discard|restore] [selector]`: look at the
 * unfinished queue before letting a provider loose on it, and set aside or
 * delete what an incident put there. A change needs a selector — there is no
 * "all", because the queue also holds real work.
 */
function memoryBacklog(argv: string[]): void {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  const batch = flag(argv, '--batch');
  const sel: BacklogSelector = {
    helpers: argv.includes('--helpers'),
    project: flag(argv, '--project'),
    session: flag(argv, '--session'),
    batch: batch === undefined ? undefined : Number(batch),
  };
  if (sel.batch !== undefined && !Number.isInteger(sel.batch)) fail('--batch needs a batch id.');
  const selected = sel.helpers || sel.project !== undefined || sel.session !== undefined || sel.batch !== undefined;

  const db = openDb();
  try {
    if (action === 'list') {
      const groups = backlogSummary(db, sel);
      if (!groups.length) {
        process.stdout.write('No unfinished jobs or helper sessions.\n');
        return;
      }
      for (const g of groups) {
        process.stdout.write(
          `${String(g.batches).padStart(6)} ${g.status.padEnd(11)} ${g.project}${g.helper ? '  [observer helper sessions]' : ''}\n` +
            `       ${g.events} events · ${g.oldest.slice(0, 16).replace('T', ' ')} → ${g.newest.slice(0, 16).replace('T', ' ')}\n`,
        );
      }
      if (groups.some((g) => g.helper)) {
        process.stdout.write(
          '\nHelper sessions are the observer summarising its own runs — noise. Delete them, and the memories\n' +
            'they produced, or set the unfinished ones aside:\n' +
            '  eklavya memory backlog discard --helpers\n  eklavya memory backlog quarantine --helpers\n',
        );
      }
      return;
    }
    if (!selected) fail(`eklavya memory backlog ${action} needs --helpers, --project <key>, --session <id> or --batch <id>.`);
    if (action === 'quarantine') {
      process.stdout.write(`quarantined ${quarantineBacklog(db, sel)} job(s) — kept, and never processed until restored.\n`);
    } else if (action === 'restore') {
      process.stdout.write(`restored ${restoreBacklog(db, sel)} job(s) to the queue.\n`);
    } else if (action === 'discard') {
      const gone = discardBacklog(db, sel);
      process.stdout.write(
        `discarded ${gone.batches} batch(es), ${gone.events} evidence event(s) and ${gone.entries} memory entr${gone.entries === 1 ? 'y' : 'ies'}.\n`,
      );
    } else {
      fail('Usage: eklavya memory backlog [list|quarantine|discard|restore] [--helpers] [--project <key>] [--session <id>] [--batch <id>]');
    }
  } finally {
    db.close();
  }
}

/**
 * `eklavya memory stop`: ends the running worker and its provider call, and
 * nothing that is not theirs. The job in flight goes back to the queue.
 */
function memoryStop(): void {
  if (isInternalObserver()) return;
  const db = openDb();
  void stopWorker(db).then((outcome) => {
    const { config } = loadConfig();
    if (!outcome.stopped) {
      process.stdout.write('no memory worker is running.\n');
    } else {
      process.stdout.write(
        `stopped the memory worker${outcome.pid ? ` (pid ${outcome.pid})` : ''}${
          outcome.child ? ` and its claude call (pid ${outcome.child})` : ''
        }${outcome.forced ? ' — it had to be killed' : ''}. Unfinished jobs stay queued.\n` +
          (outcome.released ? '' : 'something it started would not exit; the slot stays held until it does.\n'),
      );
    }
    if (config.providers.observer) {
      process.stdout.write(
        'the next session seam starts a new one. To keep it stopped: eklavya config set providers.observer null\n',
      );
    }
    db.close();
  });
}

/**
 * Backfills from Claude Code's own transcripts.
 *
 * The hooks only see sessions that happened after Eklavya was installed. This
 * is for the ones before it, and for a session where a hook was misconfigured:
 * the transcript is on disk either way, and it goes through the same privacy
 * filter and converges with whatever the hooks already captured.
 */
function memoryReplay(argv: string[]): void {
  const db = openDb();
  try {
    const { config } = loadConfig();
    if (!config.memory.enabled) {
      process.stdout.write('memory.enabled is false, so there is nowhere to replay into.\n');
      return;
    }
    const cwd = process.cwd();
    const files = transcriptsFor(cwd);
    if (!files.length) {
      process.stdout.write(
        `No Claude Code transcripts found for this checkout.\nLooked in: ${transcriptDirFor(cwd)}\n`,
      );
      return;
    }
    const limit = Number(flag(argv, '--limit', '20'));
    const results = replayProject(db, config, cwd, { limit });
    const total = results.reduce(
      (sum, r) => ({
        read: sum.read + r.read,
        captured: sum.captured + r.captured,
        duplicates: sum.duplicates + r.duplicates,
        excluded: sum.excluded + r.excluded,
      }),
      { read: 0, captured: 0, duplicates: 0, excluded: 0 },
    );
    process.stdout.write(
      [
        `transcripts: ${results.length} of ${files.length}`,
        `lines read:  ${total.read}`,
        `captured:    ${total.captured}`,
        `already had: ${total.duplicates}`,
        `excluded:    ${total.excluded}  (privacy filter, or capture set to minimal)`,
        '',
        'Run `eklavya memory process` to summarise what was captured.',
        '',
      ].join('\n'),
    );
  } finally {
    db.close();
  }
}

function memoryPrune(): void {
  const db = openDb();
  try {
    const { config } = loadConfig();
    if (!config.memory.retention_days) {
      process.stdout.write(
        'memory.retention_days is not set for this project, so its raw evidence is kept until deleted by hand.\n',
      );
      return;
    }
    // This project only, under this project's resolved retention: another
    // project may keep its evidence (retention unset) or a different window.
    const project = currentProject();
    const removed = pruneEvidence(db, config, { project });
    process.stdout.write(
      `Deleted ${removed} raw evidence events older than ${config.memory.retention_days} days in ${project}.\n`,
    );
  } finally {
    db.close();
  }
}

/** The field-disposition report, printed before anything is written. */
function dispositionReport(fields: FieldDisposition[]): string {
  const lines: string[] = [];
  for (const kind of ['mapped', 'dropped', 'unrecognised'] as const) {
    const group = fields.filter((f) => f.kind === kind);
    if (!group.length) continue;
    lines.push('', `${kind} (${group.length}):`);
    for (const f of group) {
      lines.push(`  ${f.table}.${f.field}${f.to ? ` -> ${f.to}` : ''}${f.reason ? `  — ${f.reason}` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Reads `--map source=/path` and `--map-here source` into a project map.
 *
 * Eklavya keys a project by the checkout's absolute realpath; Claude Mem keys
 * it by a bare name. Without a mapping the import is honest and useless at the
 * moment it matters -- every row lands in a scope no session queries, so a
 * search in the very repository the history came from finds nothing. The
 * importer cannot guess which checkout `eklavya` meant, so this is a flag.
 */
function projectMapFrom(argv: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--map') {
      const pair = argv[i + 1] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) fail('Usage: --map <source-project>=<path-to-checkout>');
      map[pair.slice(0, eq)] = projectKey(findRepoConfig(pair.slice(eq + 1)).repoRoot ?? pair.slice(eq + 1));
      i++;
    } else if (argv[i] === '--map-here') {
      const name = argv[i + 1];
      if (!name || name.startsWith('--')) fail('Usage: --map-here <source-project>');
      const here = findRepoConfig(process.cwd()).repoRoot;
      // "Here" has to be somewhere. Without a checkout `projectKey` answers with
      // the global bucket, so the flag would file every row under a scope no
      // session queries -- silently, permanently, and to say it had mapped them.
      if (!here) fail(`--map-here needs a checkout: ${process.cwd()} is not inside a git repository.`);
      map[name] = projectKey(here);
      i++;
    }
  }
  return map;
}

/** The `--verify` report: every source row by id, then where each project landed. */
function verifyLines(r: VerifyReport): string[] {
  const missing = r.tables.reduce((n, t) => n + t.missing.length, 0);
  const width = Math.max(0, ...r.projects.map((p) => p.project.length));
  return [
    `verify:  ${r.sourcePath}`,
    ...r.tables.map(
      (t) =>
        `  ${t.table.padEnd(18)} ${String(t.source).padStart(6)} in source · ${String(t.present).padStart(6)} in Eklavya · ${t.missing.length} missing${
          t.missing.length ? ` (ids ${t.missing.slice(0, 10).join(', ')}${t.missing.length > 10 ? ', …' : ''})` : ''
        }`,
    ),
    `  changed since import: ${r.changed} entr${r.changed === 1 ? 'y' : 'ies'}`,
    'placement:',
    ...r.projects.flatMap((p) =>
      Object.entries(p.filedUnder).map(([to, n]) => {
        const placed = path.isAbsolute(to);
        return `  ${String(n).padStart(6)}  ${p.project.padEnd(width)}  ${placed ? `→ ${to}` : 'not placed — searchable only with --all-projects; --map it to a checkout'}`;
      }),
    ),
    missing
      ? `INCOMPLETE: ${missing} source row(s) are not in Eklavya — re-run without --verify to import them.`
      : 'complete: every source row is in Eklavya.',
  ];
}

async function memoryImport(argv: string[]): Promise<void> {
  const flagValues = new Set(
    argv.flatMap((a, i) => (a === '--map' || a === '--map-here' ? [argv[i + 1] ?? ''] : [])),
  );
  const source = argv.find((a) => !a.startsWith('--') && !flagValues.has(a));
  if (!source) fail('Usage: eklavya memory import <path-to-claude-mem.db> [--dry-run] [--verify] [--resume] [--map <src>=<path>]');
  const dryRun = argv.includes('--dry-run');
  const explicit = projectMapFrom(argv);

  try {
    if (argv.includes('--verify')) {
      const db = openDb();
      try {
        const report = verifyImport(db, source);
        process.stdout.write(`${verifyLines(report).join('\n')}\n`);
        if (report.tables.some((t) => t.missing.length)) process.exit(1);
      } finally {
        db.close();
      }
      return;
    }
    const found = inventory(source);
    // Placed the way `eklavya install` places them -- off Claude Code's
    // transcripts -- so a re-run by hand files history where install would
    // have. A --map names what the transcripts cannot, and wins.
    const unsure: Record<string, string[]> = {};
    const projectMap = { ...guessProjectMap(source, claudeHome(), unsure), ...explicit };
    for (const name of Object.keys(explicit)) delete unsure[name];
    const unsureLines = Object.entries(unsure).map(
      ([name, paths]) => `  ${name}: ${paths.length} checkouts carry this name — pick one: --map ${name}=<path>  (${paths.join(', ')})`,
    );
    const lines = [
      `source:  ${found.sourcePath}`,
      `schema:  ${found.schemaVersion ?? 'unversioned'} (this importer understands up to ${found.supportedMax})`,
      `range:   ${found.dateRange.from?.slice(0, 10) ?? '—'} … ${found.dateRange.to?.slice(0, 10) ?? '—'}`,
      'tables:',
      ...found.tables.map((t) => `  ${t.rows.toString().padStart(7)}  ${t.name}${t.known ? '' : '   (unrecognised)'}`),
      'projects:',
      ...found.projects.map((p) => `  ${p.entries.toString().padStart(7)}  ${p.project}`),
      dispositionReport(found.fields),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);

    if (!found.supported) fail(`\n${found.problem ?? 'Unsupported source database.'}`);
    if (dryRun) {
      const planned = Object.entries(projectMap);
      const unmapped = found.projects.map((p) => p.project).filter((p) => !(p in projectMap));
      process.stdout.write(
        [
          '',
          ...planned.map(([from, to]) => `would map: ${from} -> ${to}`),
          ...(unmapped.length ? [`would keep as-is: ${unmapped.join(', ')}`] : []),
          ...unsureLines,
          'Dry run: nothing was written, and the source was opened read-only.',
          '',
        ].join('\n'),
      );
      return;
    }

    {
      process.stdout.write('\n');
      const { report, verified } = await spin('import', 'importing…', () =>
        importOffThread({ dbFile: dbPath(), source, opts: { resume: argv.includes('--resume'), projectMap } }),
      );
      const rows = IMPORTED_TABLES.map(
        (t) =>
          `  ${t.padEnd(18)} read ${report.read[t]} · imported ${report.imported[t]} · already present ${report.skipped[t]}`,
      );
      process.stdout.write(
        [
          '',
          `snapshot: ${report.snapshot}`,
          ...rows,
          `  concept candidates: ${report.candidates} (all unassessed — no mastery, no attempts, no gate touched)`,
          `  evidence links: ${report.links} (drill-down from an entry to the prompts and tool uses behind it)`,
          `  re-indexed: ${report.reindexed} entries`,
          ...(report.rehomed ? [`  re-homed: ${report.rehomed} entries an earlier run left under a bare project name`] : []),
          `  validation: ${report.validation.ok ? 'ok' : `FAILED — ${report.validation.notes.join('; ')}`}`,
          ...report.projectsMapped.map((p) => `  mapped: ${p.from} -> ${p.to}`),
          // The unmapped list is the useful half: those rows only ever surface
          // under --all-projects until somebody maps them.
          ...(report.projectsKept.length
            ? [
                `  kept as-is: ${report.projectsKept.join(', ')}`,
                '  (unmapped projects are searchable only with --all-projects; re-run with --map to file them under a checkout)',
              ]
            : []),
          '',
        ].join('\n'),
      );
      if (unsureLines.length) process.stdout.write(`${unsureLines.join('\n')}\n`);
      if (!report.validation.ok) process.exit(1);
      // Counts agreeing is what validation proves; this proves every source
      // row by id, and shows where each project's history is filed.
      process.stdout.write(`\n${verifyLines(verified).join('\n')}\n`);
      if (verified.tables.some((t) => t.missing.length)) process.exit(1);
    }
  } catch (err) {
    if (err instanceof ImportError) fail(err.message);
    // The source is a hand-typed path, so pointing it at the wrong file is the
    // likeliest mistake there is. The missing-file case was already handled and
    // `restore` says "is not readable JSON" for the same mistake; only this path
    // let a driver error out with a stack through node_modules.
    fail(`eklavya memory import: cannot read ${source} — ${(err as Error).message}`);
  }
}

function memoryExport(argv: string[]): void {
  const out = argv.find((a) => !a.startsWith('--'));
  if (!out) fail('Usage: eklavya memory export <path> [--force]');
  const force = argv.includes('--force');
  // Refused before the database is opened: an existing file might be the only
  // copy of an earlier export, and a typo in a path should not cost it.
  if (!force && fs.existsSync(out)) fail(`eklavya memory export: ${out} already exists. Pass --force to replace it.`);

  const db = openDb();
  try {
    const payload = exportPayload(db);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    // 0600: this is the developer's whole project history, prompts included.
    // `wx` makes the no-overwrite promise atomic; the chmod covers a file
    // `--force` replaced, whose old mode `mode` would otherwise keep.
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: force ? 'w' : 'wx' });
    fs.chmodSync(out, 0o600);
    process.stdout.write(
      `Wrote ${out} — ${(payload.entries as unknown[]).length} entries, schema version ${EXPORT_SCHEMA_VERSION}\n`,
    );
  } finally {
    db.close();
  }
}

/**
 * `eklavya memory restore <file>` — the other half of the backup pair.
 *
 * Without it `export` writes a file nothing on the machine can read, which
 * makes the rollback drill in the migration guide unrunnable. It is additive
 * and idempotent, so it is also how a second device is brought up to date from
 * a file rather than a shared folder.
 */
function memoryRestore(argv: string[]): void {
  const from = argv.find((a) => !a.startsWith('--'));
  if (!from) fail('Usage: eklavya memory restore <file>');

  const db = openDb();
  try {
    const r = restoreExport(db, path.resolve(from));
    process.stdout.write(
      [
        `Restored ${from} (export schema version ${r.schemaVersion}):`,
        `  entries:   ${r.entries.restored} restored, ${r.entries.skipped} already here`,
        `  evidence:  ${r.evidence.restored} restored, ${r.evidence.skipped} already here`,
        `  links:     ${r.tags} tag(s), ${r.links} evidence link(s)`,
        `  receipts:  ${r.receipts.restored} restored, ${r.receipts.skipped} already here (${r.receiptItems} item(s))`,
        `  reindexed: ${r.reindexed} entries — search index and vectors rebuilt`,
        'Learning history was not touched: no attempt, mastery or gate row is written by a restore.',
        '',
      ].join('\n'),
    );
  } catch (err) {
    if (err instanceof ImportError) fail(err.message);
    throw err;
  } finally {
    db.close();
  }
}

/**
 * `eklavya memory sync push|pull|status [--target <dir>]` (ADR-09).
 *
 * The directory is the whole protocol, so the command has no host, no token and
 * no network error to report — only what it wrote and what it read back.
 * `--target` overrides `sync.target` for one run; it does not override
 * `sync.enabled`, because "point it somewhere for a second" is still a decision
 * to publish this machine's memory.
 */
function memorySync(argv: string[]): void {
  const [sub] = argv;
  if (sub !== 'push' && sub !== 'pull' && sub !== 'status') {
    fail('Usage: eklavya memory sync <push|pull|status> [--target <dir>]');
  }
  const target = flag(argv, '--target') ?? null;

  const db = openDb();
  try {
    const { config } = loadConfig();

    if (sub === 'status') {
      const s = syncStatus(db, config, { target });
      const lines = [
        `sync:       ${s.enabled ? 'on' : 'off (set sync.enabled)'}`,
        `target:     ${s.target ?? '— (set sync.target, or pass --target)'}`,
        `device:     ${s.device_id ?? '—'}`,
        `revision:   ${s.local_revision}`,
        `pending:    ${s.pending} local change${s.pending === 1 ? '' : 's'} to push`,
        `conflicts:  ${s.open_conflicts} quarantined`,
        `peers:      ${
          s.peers.length
            ? s.peers.map((p) => `${p.device_id}@${p.last_revision}`).join(', ')
            : 'none seen yet'
        }`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }

    const result = sub === 'push' ? push(db, config, { target }) : pull(db, config, { target });
    if (!result.ok) {
      fail(
        result.reason === 'disabled'
          ? 'Sync is off. Set sync.enabled to true in ~/.eklavya/config.json.'
          : 'No sync target. Set sync.target to a folder your devices share, or pass --target.',
      );
    }

    if (sub === 'push') {
      const r = result as ReturnType<typeof push>;
      process.stdout.write(
        `Pushed to ${r.target} as ${r.device_id}: ${r.staged} new revision${
          r.staged === 1 ? '' : 's'
        }, ${r.written} record${r.written === 1 ? '' : 's'} written, ${r.already} already there.\n`,
      );
      return;
    }

    const r = result as ReturnType<typeof pull>;
    process.stdout.write(
      `Pulled from ${r.target}: ${r.applied} applied (${r.tombstones} deletion${
        r.tombstones === 1 ? '' : 's'
      }), ${r.skipped} already known, ${r.conflicts} quarantined.\n`,
    );
    if (r.conflicts) {
      process.stdout.write(
        'Quarantined versions are kept whole in sync_conflicts — nothing was overwritten.\n',
      );
    }
    if (r.stalled.length) {
      process.stdout.write(
        `Stopped early on an unreadable record from: ${r.stalled.join(', ')} — likely still being written. Try again.\n`,
      );
    }
  } finally {
    db.close();
  }
}

export function memoryCommand(argv: string[]): void {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'status':
      return memoryStatus();
    case 'search':
      return memorySearch(rest);
    case 'timeline':
      return memoryTimeline(rest);
    case 'show':
      return memoryShow(rest);
    case 'replay':
      return memoryReplay(rest);
    case 'process':
      return memoryProcess(rest);
    case 'stop':
      return memoryStop();
    case 'backlog':
      return memoryBacklog(rest);
    case 'prune':
      return memoryPrune();
    case 'import':
      // Async only so the spinner turns: the import itself runs on a worker.
      void memoryImport(rest);
      return;
    case 'export':
      return memoryExport(rest);
    case 'restore':
      return memoryRestore(rest);
    case 'sync':
      return memorySync(rest);
    default:
      process.stderr.write(MEMORY_USAGE);
      process.exit(1);
  }
}
