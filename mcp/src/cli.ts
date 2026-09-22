#!/usr/bin/env node
/**
 * The `eklavya` CLI: the parts of Eklavya that make sense outside a Claude Code
 * session. The commit gate has its own POSIX script (`cli/eklavya-gate`) because
 * a git hook must not pay Node's startup cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from './db.js';
import { dbPath, eklavyaHome } from './paths.js';
import { readStdinBounded, stripBom, STATUSLINE_STDIN } from './stdin.js';
import {
  loadConfig,
  writeConfigFile,
  readConfigFile,
  DEFAULT_CONFIG,
  findRepoConfig,
  mainRepoRoot,
  migrateLegacyRepoConfig,
} from './config.js';
import { isKnownKey, knownKeys, parseValue, patchFor } from './config-path.js';
import { loadPacks, applyPacks } from './packs.js';
import { levelStanding, projectKey } from './store.js';
import { statusLine } from './statusline.js';
import { isSessionOff } from './session.js';
import { START_LEVEL, type Level } from './srs.js';
import Database from 'better-sqlite3';
import { startDashboard, openInBrowser } from './dashboard.js';
import { install, uninstall, health } from './install.js';
import { identityFor } from './memory/identity.js';
import {
  countEntries,
  entryById,
  entryEvents,
  entryTags,
  pendingEventCount,
  receiptTotals,
  resumePaused,
  timeline,
} from './memory/store.js';
import { search, type SearchMode } from './memory/search.js';
import { pull, push, syncStatus } from './memory/sync.js';
import { processPending, pruneEvidence, queueDepth, summarizerFor } from './memory/worker.js';
import { replayProject, transcriptDirFor, transcriptsFor } from './memory/replay.js';
import { droppedCount } from './memory/spool.js';
import { savingsFrom, savingsLine } from './memory/tokens.js';
import {
  importFrom,
  inventory,
  exportPayload,
  restoreExport,
  EXPORT_SCHEMA_VERSION,
  ImportError,
  IMPORTED_TABLES,
  type FieldDisposition,
} from './memory/import.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `eklavya — local learning state for agent-assisted development

Usage:
  eklavya serve                         Run the MCP server on stdio (what Claude Code starts)
  eklavya install                       Install Eklavya into Claude Code, runtime included
  eklavya uninstall [--purge]           Remove it (--purge also deletes your learning history)
  eklavya export-rules [--out <file>]   Write the tutor pedagogy as a Cursor rules file
  eklavya config get                    Show the effective configuration
  eklavya config set <key> <value>      Change a setting (--project scopes it to this codebase,
                                        stored under ~/.eklavya/projects/, never in the repo)
                                        e.g. quiz.enabled true|false, quiz.enforced true|false,
                                        focus project|concept|learn, cadence interleaved|end,
                                        difficulty auto|easy|medium|hard
                                        add --topic <topic> when setting focus to "learn"
  eklavya dashboard [--port <n>]        Serve the learning dashboard and open it in your browser
                                        (--no-open serves it and just prints the URL)
  eklavya statusline                    Print the dials for a status bar (one line, or nothing)
  eklavya doctor                        Check the install, apply concept packs, and say what to fix
  eklavya db-path                       Print the database location

Memory:
  eklavya memory status                 Entries, pending evidence, queue depth, provider and savings
  eklavya memory search <query>         Search this project's memory
                                        [--mode keyword|semantic|hybrid] [--limit <n>] [--all-projects]
  eklavya memory timeline               Recent entries, newest first [--limit <n>] [--since <iso date>]
  eklavya memory show <id>              One entry, with the evidence it was built from
  eklavya memory replay [--limit <n>]   Backfill from this checkout's Claude Code transcripts
                                        Covers sessions from before the install, and any a hook missed
  eklavya memory process [--max <n>]    Drain the observation queue now
                                        Resumes jobs paused on a credential or quota — run it once you have fixed one
  eklavya memory prune                  Delete raw evidence past memory.retention_days
  eklavya memory import <source.db>     Import a Claude Mem database [--dry-run] [--resume]
                                        --dry-run reads the source and reports; it writes nothing
                                        --map <source>=<path>  file that source project under a checkout
                                        --map-here <source>    the same, for the checkout you are in
  eklavya memory export <file>          Versioned JSON of entries, tags, evidence links and receipts
  eklavya memory restore <file>         Read that file back in. Additive and idempotent — a second
                                        restore adds nothing, and no attempt, mastery or gate row is
                                        touched. Refuses a schema version it does not understand
  eklavya memory sync <push|pull|status>  Exchange memory with your other devices through a shared
                                        folder [--target <dir>]. Memory entries, tags and tombstones
                                        only — attempts, mastery, gates and receipts never leave.
                                        Needs sync.enabled and sync.target; does nothing without both

Config keys: focus, focus_topic, cadence, difficulty, level_up_after,
             level_up_accuracy, pass_threshold, max_questions_per_task,
             min_minutes_between_quizzes, min_minutes_between_checkpoints,
             max_new_concepts_per_session, max_stop_blocks_per_session, quiet
Config namespaces (nested; edit ~/.eklavya/config.json or this project's file directly):
  quiz.{enabled, enforced} — whether questions happen, and whether they gate
             commits. Separate from memory: silencing questions never stops
             recording. (mode: ambient|enforced|off is the retired spelling,
             still read so older configs keep working)
  memory.{enabled, capture: full|minimal|off, batch_max_events, retention_days}
  privacy.{exclude_paths, exclude_tools, redact_patterns}
  retrieval.{mode: keyword|semantic|hybrid, max_items, max_tokens, cross_project}
  providers.{observer, embeddings} — each null or {kind, model, api_key_env};
             api_key_env names the variable holding the key, never the key itself
  notifications.{enabled, sinks} — sinks are {kind: webhook|command|file, target,
             args, events}; off by default, and a send cannot be recalled
  sync.{enabled, target, device_id} — target is a folder both devices can see
             (Dropbox, iCloud, Syncthing, a share); off and unset by default.
             device_id is normally left null: it is generated once per install
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * The pedagogy is one SKILL.md plus `references/*.md`, and Claude Code reads
 * those on demand -- SKILL.md says "read references/grading.md before you
 * grade" and the model opens the file.
 *
 * A Cursor rules file has no such mechanism. It is one document with
 * `alwaysApply: true`, so a pointer to a sibling path is a pointer to nothing.
 * The references are therefore inlined here, and the preamble says so: without
 * that, the split would have quietly cut four fifths of the pedagogy out of
 * Cursor while every test still passed.
 *
 * Alphabetical, deliberately. In an always-apply document the whole thing is in
 * context at once so order carries no meaning, and a hand-maintained order is
 * one more place a new reference file gets forgotten.
 */
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

function tutorSections(): string[] {
  const tutorDir = path.join(moduleDir, 'assets', 'tutor');
  const skillPath = path.join(tutorDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    fail('The bundled tutor skill is missing. Run `npm run build` in the mcp/ directory.');
  }

  const skill = fs.readFileSync(skillPath, 'utf8').replace(FRONTMATTER, '');
  const refsDir = path.join(tutorDir, 'references');

  // Which references are required is not a list kept here -- it is whatever
  // SKILL.md tells the model to read. Anything it names has to be inlined, or
  // the preamble below is a lie: it promises the material is further down the
  // document, so a reader who cannot find it hunts instead of falling back.
  //
  // Hence a hard failure rather than a warning. `copy-assets.mjs` only warns
  // when it cannot bundle the skill, so a half-copied directory is reachable,
  // and a rules file carrying the dispatch logic and none of the craft is worse
  // than no rules file at all -- the split's whole failure mode, re-created at
  // the last step.
  const cited = [...skill.matchAll(/references\/([a-z0-9-]+\.md)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  const required = [...new Set(cited)];
  const missing = required.filter((name) => !fs.existsSync(path.join(refsDir, name)));
  if (missing.length > 0) {
    fail(
      `The tutor skill's reference files are missing: ${missing.join(', ')}.\n` +
        'Run `npm run build` in the mcp/ directory.',
    );
  }

  const sections = [skill.trim()];
  // Read from the directory rather than from `required`, so a reference that
  // ships without being pointed at is still inlined. Frontmatter stripped from
  // each: a stray YAML block mid-document renders as content in a rules file,
  // and the natural instinct for a file inside a skill directory is to give it
  // some.
  if (fs.existsSync(refsDir)) {
    for (const name of fs.readdirSync(refsDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const body = fs.readFileSync(path.join(refsDir, name), 'utf8').replace(FRONTMATTER, '');
      sections.push(body.trim());
    }
  }

  return sections;
}

function exportRules(args: string[]): void {
  const rules = `---
description: Eklavya tutor — teach the concepts behind the code being written
alwaysApply: true
---

<!-- Generated by \`eklavya export-rules\`. Do not edit by hand; edit the plugin's
     skills/tutor/SKILL.md and its references/ and regenerate, so Claude Code and
     Cursor never drift. -->

The Eklavya MCP server is available in this editor. Its tools are the source of
truth for what this developer already knows.

The first section below is the skill itself; the ones after it are its
reference files, inlined, because this editor has no way to open one on demand.
Read them as part of the whole: wherever the first section says to read
\`references/something.md\`, that material is further down this same file.

${tutorSections().join('\n\n')}
`;

  const outIndex = args.indexOf('--out');
  if (outIndex >= 0) {
    const out = args[outIndex + 1];
    if (!out) fail('--out needs a file path.');
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, rules, 'utf8');
    process.stdout.write(`Wrote ${out}\n`);
    return;
  }

  process.stdout.write(rules);
}

function configCommand(args: string[]): void {
  // Before reading or writing anything: a leftover `.eklavya.json` in the
  // checkout is moved out first, so `config get` reports one source of truth
  // and `config set --project` cannot leave settings split across two files.
  const here = findRepoConfig().repoRoot;
  if (here) migrateLegacyRepoConfig(here, mainRepoRoot(here));

  const [action, rawKey, rawValue] = args;
  // `mode` is read from config files forever, but it is no longer written to
  // one. A `config set` is somebody typing today, so it is the moment to hand
  // them the names that replaced it -- translating and saying so beats both a
  // dead-end "unknown setting" and silently writing a key that nothing lists.
  let key = rawKey;
  let value = rawValue;
  let modeNote: string | null = null;
  // Both flags, never one. `mode` named a *pair* of states, so translating it
  // to a single dotted key left the other flag standing: `mode ambient` wrote
  // `quiz.enabled true` over an existing `quiz.enforced: true` and reported
  // success while commits stayed gated -- and `mode enforced` against an
  // existing `quiz.enabled: false` was a silent no-op that `coerceNamespaces`
  // undid and `doctor` then reported as a contradiction. `set_config` always
  // wrote the pair; this is the CLI catching up.
  let modeQuiz: { enabled: boolean; enforced: boolean } | null = null;
  if (rawKey === 'mode') {
    if (rawValue !== 'ambient' && rawValue !== 'enforced' && rawValue !== 'off') {
      fail('`mode` was replaced by `quiz.enabled` and `quiz.enforced`. Set those directly: eklavya config set quiz.enabled false');
    }
    key = 'quiz';
    modeQuiz = {
      enabled: rawValue !== 'off',
      enforced: rawValue === 'enforced',
    };
    value = JSON.stringify(modeQuiz);
    modeNote =
      `note:     \`mode ${rawValue}\` is now \`quiz.enabled ${modeQuiz.enabled}, quiz.enforced ${modeQuiz.enforced}\`. ` +
      (rawValue === 'off'
        ? 'This stops the questions only — memory keeps recording; `memory.enabled false` is that switch.'
        : 'Memory is governed separately by `memory.enabled`.');
  }
  // `--project` is the name; `--repo` is what it was called when the file lived
  // in the repository, kept because it is in every doc and shell history written
  // before the move. Accepting only one of them silently wrote to the global
  // config instead, which is a setting landing somewhere nobody asked for.
  const scopeRepo = args.includes('--project') || args.includes('--repo');
  const resolved = loadConfig();

  if (!action || action === 'get') {
    process.stdout.write(`${JSON.stringify(resolved.config, null, 2)}\n`);
    process.stdout.write(`\nglobal: ${resolved.globalPath}\n`);
    process.stdout.write(`project: ${resolved.projectPath ?? '(none — not in a git repository)'}\n`);
    return;
  }

  if (action !== 'set') fail(`Unknown config action "${action}".`);
  if (!key || value === undefined) fail('Usage: eklavya config set <key> <value>');
  if (!isKnownKey(key)) {
    fail(`Unknown setting "${key}". Known: ${knownKeys().join(', ')}`);
  }

  // `focus learn` is useless without a topic, so let one call say both rather
  // than leaving a state that the planner will only refuse later.
  const topicIndex = args.indexOf('--topic');
  const topic = topicIndex === -1 ? undefined : args[topicIndex + 1];
  if (topicIndex !== -1 && !topic) fail('--topic needs a value.');
  if (topic !== undefined && key !== 'focus' && key !== 'focus_topic') {
    fail('--topic only applies when setting focus.');
  }
  if (key === 'focus' && value === 'learn' && topic === undefined) {
    fail('focus "learn" needs a topic: eklavya config set focus learn --topic <topic>');
  }

  // Typed by the schema at that path rather than guessed from the text. A
  // topic of "2" is a topic; `memory.batch_max_events` of "40" is a number,
  // and only the default sitting there knows which is which.
  const parsed = modeQuiz ?? parseValue(key, value);

  // Nothing here writes into the checkout. `--project` (and its older spelling
  // `--repo`) means "this project", not "this repository's working tree": the
  // file lands under ~/.eklavya/projects/, keyed by the checkout's path. There
  // is no forbidden-key list any more, because there is no longer such a thing
  // as a config file that arrived from somebody else.
  let target: string;
  if (scopeRepo) {
    if (!resolved.projectPath) {
      fail('Not inside a git repository, so there is no project to scope this to.');
    }
    target = resolved.projectPath!;
  } else {
    target = resolved.globalPath;
  }

  // Built against the file being written, not against nothing: the two config
  // files merge with a shallow spread, so a patch that replaced a whole
  // namespace would drop every other key already set in it.
  const existing = readConfigFile(target);
  const patch: Record<string, unknown> = patchFor(existing, key, parsed);
  if (topic !== undefined && key === 'focus') patch.focus_topic = topic;
  // Which checkout this file is about, so a slug collision is detected rather
  // than applied to the wrong repository. See `belongsTo` in config.ts.
  if (scopeRepo && resolved.repoRoot) patch.project = mainRepoRoot(resolved.repoRoot);

  writeConfigFile(target, patch);
  for (const [k, v] of Object.entries(patch)) {
    process.stdout.write(`${k} = ${JSON.stringify(v)}  ->  ${target}\n`);
  }
  if (modeNote) process.stdout.write(`${modeNote}\n`);
}

/** Never throws: `doctor` is also what someone runs on a half-built database. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function doctor(): void {
  const file = dbPath();
  // `doctor` is where somebody goes when something is not taking effect, so it
  // is the second place the legacy move runs -- a settings file still sitting
  // in the checkout is exactly that complaint.
  const repoHere = findRepoConfig().repoRoot;
  if (repoHere) migrateLegacyRepoConfig(repoHere, mainRepoRoot(repoHere));
  const resolved = loadConfig();
  const lines: string[] = [];
  let ok = true;
  // Kept apart from `ok` so the blanket remedy below stays true: `eklavya
  // install` repairs a broken install and cannot do a thing about a paused
  // queue. A memory failure still exits non-zero; it just names its own fix.
  let memoryOk = true;

  lines.push(`home:     ${eklavyaHome()}`);

  // The install checks come first because they are what someone is looking for
  // when Eklavya has gone quiet. Everything below reads fine on an install that
  // Claude Code can no longer load at all.
  const checks = health();
  for (const check of checks) {
    if (!check.ok) ok = false;
    lines.push(`${`${check.name}:`.padEnd(10)}${check.ok ? '' : 'FAILED — '}${check.detail}`);
  }

  // Which surfaces the checks above actually cover. The `plugin` check reads
  // Claude Code's registry under `~/.claude`, which the Code tab in Claude
  // Desktop shares — so one OK covers both. Cowork keeps its own registry
  // inside the app's data directory and is installed from its own UI, so a
  // green doctor says nothing about it. Someone whose Cowork sessions are
  // silent needs to be told that here, not left reading a clean report.
  lines.push('surfaces: Claude Code CLI and the Code tab in Claude Desktop (checked above).');
  lines.push(
    '          Cowork keeps a separate plugin list — install it there from Customize → Plugins;',
  );
  lines.push('          this command cannot see it. Your learning history is shared either way.');

  lines.push(`database: ${file}${fs.existsSync(file) ? '' : '   (not created yet)'}`);

  let edgesDropped = 0;
  // Held open past the try so the memory section below can read it, and can
  // still report when it is null -- the spool drop count is exactly the number
  // that matters when the database is the thing that is broken.
  let db: DB | null = null;
  try {
    db = openDb(file);
    // Applied here, on the connection `doctor` already has, and unconditionally
    // -- every other path skips when the fingerprint matches, which leaves no
    // recovery for the edit a fingerprint cannot see (a same-size write that
    // preserves the mtime). `doctor` is where someone goes when a pack is not
    // taking effect, so `doctor` is what makes it take effect.
    edgesDropped = applyPacks(db).edgesDropped;
    const concepts = (db.prepare('SELECT count(*) n FROM concepts').get() as { n: number }).n;
    const attempts = (db.prepare('SELECT count(*) n FROM attempts').get() as { n: number }).n;
    const known = (
      db.prepare('SELECT count(*) n FROM mastery WHERE score >= 0.7 AND reps >= 2').get() as { n: number }
    ).n;
    lines.push(`concepts: ${concepts}`);
    lines.push(`attempts: ${attempts}`);
    lines.push(`mastered: ${known}`);
    lines.push(`journal:  ${String(db.pragma('journal_mode', { simple: true }))}`);
    // The project's band, and the runway left in it. Read here because `doctor`
    // is where someone looks when the questions feel wrong for them.
    const standing = levelStanding(db, resolved.config, resolved.repoRoot);
    lines.push(
      `level:    ${standing.level}${
        standing.pinned
          ? ' (pinned by config — no progression)'
          : ` (${standing.counts.passed}/${standing.needed.answers} passing answers in ${standing.repo})`
      }`,
    );
  } catch (err) {
    ok = false;
    lines.push(`database error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The memory half. `eklavya memory status` says more, but it is scoped to one
  // project and nobody runs it when the question is "is anything broken" — so
  // the two failures that are otherwise completely silent, a queue paused on a
  // provider and evidence dropped before it reached the database, are reported
  // here. Every read degrades rather than throws.
  // The contradiction `coerce()` silently resolves, said out loud exactly once,
  // here. `quiz.enabled: false` with `quiz.enforced: true` is a gate whose
  // questions never get asked; `coerce` drops the enforcement so nobody is
  // locked out of their own repository, but a lead who wrote that line believes
  // commits are being held and they are not. `doctor` is where somebody goes to
  // find out why -- so it has to be findable here rather than only in a comment.
  const rawQuiz = resolved.raw.quiz as Record<string, unknown> | undefined;
  if (rawQuiz?.enabled === false && rawQuiz?.enforced === true) {
    ok = false;
    lines.push(
      'conflict: FAILED — quiz.enabled is false and quiz.enforced is true. A gate needs ' +
        'passed questions and nothing will ask any, so the enforcement is being ignored ' +
        'rather than blocking every commit. Set quiz.enabled true to gate commits, or drop ' +
        'quiz.enforced to accept the silence.',
    );
  }

  const memory = resolved.config.memory;
  lines.push(
    `memory:   ${memory.enabled ? `on · capture ${memory.capture}` : 'off (memory.enabled is false)'}`,
  );

  if (db) {
    const entries = safely(() => countEntries(db!), 0);
    const evidence = safely(
      () => (db!.prepare('SELECT count(*) n FROM evidence_events').get() as { n: number }).n,
      0,
    );
    const waiting = safely(() => pendingEventCount(db!), 0);
    lines.push(`memory:   ${entries} entries, ${evidence} evidence events (${waiting} not yet summarised)`);

    const queue = safely(() => queueDepth(db!), { pending: 0, paused: 0, failed: 0, oldest: null });
    lines.push(`memory:   queue ${queue.pending} pending · ${queue.paused} paused · ${queue.failed} failed`);

    // The class, never the message. `last_error` is the provider's own prose
    // and has carried a URL with a token in it; the class is what tells someone
    // whether to fix a key or a quota, and it is a fixed vocabulary.
    const classes = (status: string): string =>
      safely(
        () =>
          (
            db!
              .prepare(
                "SELECT DISTINCT error_class FROM memory_jobs WHERE status = ? AND error_class IS NOT NULL ORDER BY error_class",
              )
              .all(status) as { error_class: string }[]
          )
            .map((r) => r.error_class)
            .join(', '),
        '',
      ) || 'unclassified';

    if (queue.paused > 0) {
      memoryOk = false;
      lines.push(`memory:   FAILED — ${queue.paused} job(s) paused (${classes('paused')}); nothing is being summarised`);
      lines.push('memory:   fix the credentials or quota behind providers.observer, then: eklavya memory process');
    }
    if (queue.failed > 0) {
      // Not a failure: a permanently failed job is a batch that will never
      // summarise, and no command repairs it. Saying so beats a clean report.
      lines.push(`memory:   ${queue.failed} job(s) failed permanently (${classes('failed')})`);
    }

    // The capture heartbeat: memory that is "on" with nothing arriving is the
    // failure the entry count alone cannot show.
    const newest = safely(
      () => (db!.prepare('SELECT MAX(occurred_at) AS at FROM evidence_events').get() as { at: string | null }).at,
      null as string | null,
    );
    lines.push(`memory:   last evidence ${newest ?? '— none captured yet'}`);

    const sync = safely(() => syncStatus(db!, resolved.config), null);
    lines.push(
      `memory:   sync ${
        sync?.enabled ? `on -> ${sync.target ?? '(no target set — set sync.target)'}` : 'off'
      }`,
    );
  }

  const dropped = safely(() => droppedCount(), 0);
  if (dropped > 0) {
    // Dropped, not spooled: these events never reached the database *or* the
    // spool file, so nothing replays them on its own. The transcripts are the
    // only remaining copy.
    memoryOk = false;
    lines.push(`memory:   FAILED — ${dropped} event(s) dropped before they reached the database`);
    lines.push('memory:   recover them from this checkout’s transcripts with: eklavya memory replay');
  }
  lines.push(
    `memory:   provider ${
      resolved.config.providers.observer ? 'configured — batches leave this machine' : 'none — nothing leaves this machine'
    }`,
  );

  db?.close();

  // Per key, not per file. A project config that sets only `quiz` must not make
  // `focus` and `cadence` claim they came from it -- they came from the
  // defaults, and a line that names the wrong source is the same class of bug
  // as the dial this release renamed. `projectPath` is a path Eklavya *would*
  // write to, so the file is read rather than assumed to exist.
  const projectKeys = new Set(
    resolved.projectPath ? Object.keys(readConfigFile(resolved.projectPath)) : [],
  );
  const from = (key: string) => (projectKeys.has(key) ? ' (set for this project)' : '');
  const q = resolved.config.quiz;
  lines.push(
    `quiz:     ${q.enabled ? 'on' : 'off — memory is unaffected'}${
      q.enforced ? ' · enforced (commits gated)' : ''
    }${from('quiz')}`,
  );
  lines.push(
    `focus:    ${resolved.config.focus}${
      resolved.config.focus === 'learn' ? ` (${resolved.config.focus_topic ?? 'no topic set'})` : ''
    }${from('focus')}`,
  );
  lines.push(
    `cadence:  ${resolved.config.cadence}${
      resolved.config.cadence === 'interleaved'
        ? ` (one question mid-task, min ${resolved.config.min_minutes_between_checkpoints}m apart)`
        : ' (all questions at the end of the task)'
    }${from('cadence')}`,
  );
  if (resolved.overrides.length > 0) {
    lines.push(`overridden for this project: ${resolved.overrides.join(', ')}`);
  }
  if (resolved.projectPath) lines.push(`project:  ${resolved.projectPath}`);

  // Packs, and the one place a broken one is visible. `loadPacks` never throws
  // -- a malformed file in ~/.eklavya/packs/ makes one pack unavailable, not
  // Eklavya -- so without this line the failure is a domain that quietly never
  // shows up.
  const packs = loadPacks();
  if (packs.length > 0) {
    const good = packs.filter((p) => p.pack);
    lines.push(
      `packs:    ${good.length} loaded${
        good.length > 0
          ? ` — ${good.map((p) => `${p.pack!.pack}${p.pack!.version ? `@${p.pack!.version}` : ''} (${p.scope})`).join(', ')}`
          : ''
      }`,
    );
    if (edgesDropped > 0) {
      // An edge endpoint naming nothing is almost always a typo, and it is
      // silent everywhere else: the pack loads, the concept appears, and the
      // prerequisite it was meant to hang off simply is not there.
      lines.push(
        `packs:    ${edgesDropped} edge(s) dropped — an endpoint named a slug that does not exist`,
      );
    }
    // The one remaining way an Eklavya file ends up in a checkout, and it only
    // ever got there before the move. Named rather than fixed: a committed pack
    // is authored content somebody reviewed, so relocating it is their call.
    const inRepo = good.filter((p) => p.scope === 'repo');
    if (inRepo.length > 0) {
      lines.push(
        `packs:    ${inRepo.length} still inside the checkout (${inRepo
          .map((p) => p.pack!.pack)
          .join(', ')}) — they load, but Eklavya no longer writes there;`,
      );
      lines.push(
        `packs:    move them to ~/.eklavya/projects/<checkout>/packs/ to keep the repo clean`,
      );
    }
    for (const bad of packs.filter((p) => !p.pack)) {
      // Deliberately does NOT set `ok`. A bad pack costs that pack and nothing
      // else, and the blanket remedy below is `eklavya install`, which never
      // touches ~/.eklavya/packs/ and could not repair this if it wanted to.
      lines.push(`packs:    FAILED — ${bad.file}: ${bad.error}`);
      lines.push(`packs:    fix or delete that file; everything else is unaffected`);
    }
  }

  // One fix for all of them: `install` is idempotent, so re-running it is the
  // repair. Naming it here is the whole point of the checks above — a report
  // nobody can act on is worse than no report.
  if (!ok) {
    lines.push('');
    lines.push('Something is broken. Run: eklavya install');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  if (!ok || !memoryOk) process.exit(1);
}

/**
 * `eklavya statusline` — the dials, for the host's status bar.
 *
 * Runs on every status-bar refresh, so the contract is stricter than any other
 * command's: fast, silent on every failure path, and it must never hang. It
 * prints one line or nothing at all, and exits 0 either way — a status bar is
 * not a place to report that Eklavya is unwell.
 *
 * Only the earned level and the per-session off switch need the database. The
 * dials themselves come from the config files, so an install with no database
 * yet — or one that cannot be opened — still shows its dials rather than
 * nothing. The database is consulted in its own try/catch for exactly that
 * reason: a locked or corrupt file costs the level, never the bar.
 */
async function statuslineCommand(argv: string[]): Promise<void> {
  try {
    // Claude Code writes a JSON blob to stdin (cwd, model, session). We want
    // the cwd, so this project's config is the one that answers.
    //
    // Bounded deliberately. On Windows the host may wrap a command in a
    // PowerShell block that swallows the pipe, so `end` never fires and a naive
    // read waits forever -- which in a status bar means every refresh blocks.
    // `unref` keeps the timer off the normal path, where `end` arrives first.
    const raw = await readStdinBounded(STATUSLINE_STDIN);

    let cwd = process.cwd();
    let sid: string | null = null;
    // Parsed in its own try: input we cannot read is a reason to fall back to
    // the working directory, not a reason to show the developer nothing. The
    // dials are still true; only which project's config applies was in doubt.
    try {
      if (raw.trim()) {
        // Strip a BOM: some Windows shells prepend one, and JSON.parse throws
        // on input that looks perfectly well-formed.
        const parsed: unknown = JSON.parse(stripBom(raw));
        const input = (parsed ?? {}) as {
          cwd?: string;
          session_id?: string;
          workspace?: { current_dir?: string };
        };
        cwd = input.workspace?.current_dir ?? input.cwd ?? cwd;
        sid = input.session_id ?? sid;
      }
    } catch {
      /* Unreadable stdin: process.cwd() it is. */
    }

    const resolved = loadConfig(cwd);
    const pinned = resolved.config.difficulty !== 'auto';

    let level: Level = pinned ? (resolved.config.difficulty as Level) : START_LEVEL;
    // Nothing the database says is worth losing the bar over, so its own catch:
    // before this, a corrupt or locked file threw past the level lookup and the
    // whole line vanished on every refresh.
    if ((sid || !pinned) && fs.existsSync(dbPath())) {
      let db: Database.Database | null = null;
      try {
        db = new Database(dbPath(), { readonly: true });
        // A silenced session shows no bar. It says the same thing
        // `quiz.enabled: false` says, and a bar still reciting the dials of a
        // session that will not
        // ask anything is the kind of small lie that costs a bug report.
        //
        // Only when the host named the session. The fallback would be the
        // shared `current_session` pointer, and suppressing on a guess blanks
        // the bar in every other terminal the moment one session goes quiet.
        if (sid && isSessionOff(db, sid)) return;
        // `levelStanding` rather than a query of our own: the banner learned
        // this the hard way, and a second implementation of the band rules is a
        // second thing to keep in step with the planner.
        if (!pinned) level = levelStanding(db, resolved.config, resolved.repoRoot).level;
      } catch {
        /* Unreadable database: show the dials, skip what it would have said. */
      } finally {
        db?.close();
      }
    }

    // NO_COLOR is the cross-tool convention, and some bars render the string
    // literally rather than through a terminal.
    const color = !process.env.NO_COLOR && !argv.includes('--no-color');
    const line = statusLine({ config: resolved.config, level, pinned, color });
    if (line) process.stdout.write(`${line}\n`);
  } catch {
    /* A status bar with nothing to say says nothing. */
  }
}

function dashboardCommand(argv: string[]): void {
  const i = argv.indexOf('--port');
  const port = i === -1 ? undefined : Number(argv[i + 1]);
  if (port !== undefined && !Number.isInteger(port)) {
    process.stderr.write('eklavya dashboard: --port needs a number\n');
    process.exit(1);
  }
  // Opens by default. A dashboard you have to copy out of a terminal is a
  // dashboard you open once; `--no-open` is for a headless box, or for an agent
  // that only wants the URL to hand back.
  const open = !argv.includes('--no-open');

  startDashboard(openDb(), { port }).then(
    ({ url }) => {
      process.stdout.write(
        `Eklavya dashboard on ${url}\nReading ${dbPath()} — press Ctrl+C to stop.\n`,
      );
      if (open) {
        process.stdout.write('Opening it in your browser…\n');
        openInBrowser(url);
      }
    },
    (err: Error) => {
      process.stderr.write(`eklavya dashboard: ${err.message}\n`);
      process.exit(1);
    },
  );
}

/**
 * `eklavya memory <subcommand>` — the memory half, outside a session.
 *
 * Project-scoped by default on every read, like the retrieval layer it sits on:
 * another repository's work is noise, and `--all-projects` is the explicit way
 * to ask for it.
 */
const MEMORY_USAGE =
  'Usage: eklavya memory status|search|timeline|show|replay|process|prune|import|export|restore|sync\n' +
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
      `pending:    ${pendingEventCount(db, project)} evidence events here, ${pendingEventCount(db)} in total`,
      `queue:      ${queue.pending} pending · ${queue.paused} paused · ${queue.failed} failed`,
      `oldest job: ${queue.oldest ?? '—'}`,
      // Named separately from the summarizer because they answer different
      // questions: one is "will anything leave this machine", the other is
      // "what is actually writing the observations right now".
      `provider:   ${
        config.providers.observer
          ? `${config.providers.observer.kind}:${config.providers.observer.model} (key from $${config.providers.observer.api_key_env})`
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
  const db = openDb();
  const { config } = loadConfig();
  // Running this command *is* the "I have fixed the credential" signal: it is
  // what `doctor` tells the developer to run, and nothing else takes a job off
  // 'paused'. Resuming here rather than in the worker keeps it an explicit act
  // — a hook that resumed by itself would spend a rejected key every session.
  // Validate before resuming. `numberFlag` exits on a bad value, and resuming
  // is not undoable: a refused run that had already emptied the pause would
  // tell the developer nothing happened while the queue quietly went back to
  // spending a credential that may still be rejected.
  const maxJobs = numberFlag(argv, '--max', 10);
  const resumed = resumePaused(db);
  processPending(db, config, { maxJobs }).then(
    (result) => {
      process.stdout.write(
        `${resumed ? `resumed ${resumed} paused · ` : ''}processed ${result.processed} · entries ${result.entries} · failed ${result.failed} · skipped ${result.skipped}\n`,
      );
      db.close();
    },
    (err: Error) => {
      db.close();
      fail(`eklavya memory process: ${err.message}`);
    },
  );
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
      process.stdout.write('memory.retention_days is not set, so raw evidence is kept until deleted by hand.\n');
      return;
    }
    const removed = pruneEvidence(db, config);
    process.stdout.write(`Deleted ${removed} raw evidence events older than ${config.memory.retention_days} days.\n`);
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

function memoryImport(argv: string[]): void {
  const flagValues = new Set(
    argv.flatMap((a, i) => (a === '--map' || a === '--map-here' ? [argv[i + 1] ?? ''] : [])),
  );
  const source = argv.find((a) => !a.startsWith('--') && !flagValues.has(a));
  if (!source) fail('Usage: eklavya memory import <path-to-claude-mem.db> [--dry-run] [--resume] [--map <src>=<path>]');
  const dryRun = argv.includes('--dry-run');
  const projectMap = projectMapFrom(argv);

  try {
    const found = inventory(source);
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
          'Dry run: nothing was written, and the source was opened read-only.',
          '',
        ].join('\n'),
      );
      return;
    }

    const db = openDb();
    try {
      const report = importFrom(db, source, { resume: argv.includes('--resume'), projectMap });
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
      if (!report.validation.ok) process.exit(1);
    } finally {
      db.close();
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
  if (!out) fail('Usage: eklavya memory export <path>');

  const db = openDb();
  try {
    const payload = exportPayload(db);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function memoryCommand(argv: string[]): void {
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
    case 'prune':
      return memoryPrune();
    case 'import':
      return memoryImport(rest);
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

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'serve':
      // Importing the server runs it: it owns stdout from here on, which is why
      // nothing above may print. It never returns -- the process ends when the
      // stdio transport closes.
      void import('./server.js').catch((err: unknown) => {
        process.stderr.write(`eklavya serve: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
      return;
    case 'install':
      return install(rest);
    case 'uninstall':
      return uninstall(rest);
    case 'export-rules':
      return exportRules(rest);
    case 'config':
      return configCommand(rest);
    case 'statusline':
      void statuslineCommand(rest);
      return;
    case 'dashboard':
      return dashboardCommand(rest);
    case 'memory':
      return memoryCommand(rest);
    case 'doctor':
      return doctor();
    case 'db-path':
      process.stdout.write(`${dbPath()}\n`);
      return;
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

main();
