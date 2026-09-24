#!/usr/bin/env node
/**
 * The `eklavya` CLI: the parts of Eklavya that make sense outside a Claude Code
 * session. The commit gate has its own POSIX script (`cli/eklavya-gate`) because
 * a git hook must not pay Node's startup cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DB } from './db.js';
import { dbPath, eklavyaHome } from './paths.js';
import { readStdinBounded, stripBom, STATUSLINE_STDIN } from './stdin.js';
import {
  loadConfig,
  writeConfigFile,
  readConfigFile,
  configFileProblem,
  findRepoConfig,
  mainRepoRoot,
  migrateLegacyRepoConfig,
} from './config.js';
import { isKnownKey, knownKeys, parseValue, patchFor } from './config-path.js';
import { levelStanding } from './store.js';
import { statusLine } from './statusline.js';
import { isSessionOff } from './session.js';
import { START_LEVEL, type Level } from './srs.js';
import Database from 'better-sqlite3';
import { check, dim, heading, verdict, type Mark } from './theme.js';

// Everything heavier is imported inside the command that needs it: the
// database opener (migrations, seed, packs), install, the dashboard and the
// whole memory half (`cli-memory.ts`). An ES import is paid whether or not the
// command runs, and `eklavya statusline` runs on every status-bar refresh —
// loading all of that there more than doubled its start-up for nothing.
// `test/hook-isolation.test.ts` pins it.

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `eklavya — local learning state for agent-assisted development

Usage:
  eklavya serve                         Run the MCP server on stdio (what Claude Code starts)
  eklavya install                       Install Eklavya into Claude Code, runtime included
                                        --memory eklavya|claude-mem  when Claude Mem is installed, pick
                                        which one records without being asked: eklavya imports its
                                        history and retires it; claude-mem keeps it and turns Eklavya
                                        memory off
                                        --settings  walk the settings again (a first install always does;
                                        after that they are kept and only printed)
  eklavya update                        Update now. Eklavya already updates itself in the background at
                                        session start (auto_update); this is the same run, in the open
  eklavya uninstall [--purge]           Remove it (--purge also deletes your learning history)
  eklavya export-rules [--out <file>]   Write the tutor pedagogy as a Cursor rules file
  eklavya config get                    Show the effective configuration
  eklavya config set <key> <value>      Change a setting (--project scopes it to this codebase,
                                        stored under ~/.eklavya/projects/, never in the repo)
                                        e.g. quiz.enabled true|false, quiz.enforced true|false,
                                        focus project|concept|learn, cadence interleaved|end,
                                        difficulty auto|easy|medium|hard,
                                        explain_on_wrong true|false
                                        add --topic <topic> when setting focus to "learn"
  eklavya dashboard [--port <n>]        Serve the learning dashboard and open it in your browser
                                        (--no-open serves it and just prints the URL)
  eklavya artifacts new <title>         Start a page under ~/.eklavya/artifacts/<project>/ from the
                                        Eklavya template and print its path [--description <text>]
                                        [--kind artifact|explainer] [--concept <slug>] [--open]
  eklavya artifacts list [--json]       Every artifact, newest first [--here: this project only]
  eklavya artifacts open <path|id>      Open one in your browser
  eklavya statusline                    Print the dials for a status bar (one line, or nothing)
  eklavya doctor                        Check the install, apply concept packs, and say what to fix
  eklavya db-path                       Print the database location
  eklavya telemetry [status|on|off|show]
                                        Anonymous daily usage counts: whether they are sent, turn them
                                        on or off, or print exactly what the next ping sends

Memory:
  eklavya memory status                 Entries, pending evidence, queue depth, provider and savings
  eklavya memory search <query>         Search this project's memory
                                        [--mode keyword|semantic|hybrid] [--limit <n>] [--all-projects]
  eklavya memory timeline               Recent entries, newest first [--limit <n>] [--since <iso date>]
  eklavya memory show <id>              One entry, with the evidence it was built from
  eklavya memory replay [--limit <n>]   Backfill from this checkout's Claude Code transcripts
                                        Covers sessions from before the install, and any a hook missed
  eklavya memory process [--max <n>] [--no-resume]
                                        Drain the observation queue now
                                        Resumes jobs paused on a login or usage limit — run it once that is sorted
  eklavya memory stop                   Stop the running memory worker and its claude call; the job goes back
                                        to the queue. Signals only processes Eklavya recorded starting
  eklavya memory backlog [quarantine|discard|restore]
                                        List unfinished jobs by project, marking observer helper sessions;
                                        or set aside, delete or bring back the ones you select with
                                        --helpers, --project <key>, --session <id> or --batch <id>
  eklavya memory prune                  Delete this project's raw evidence past its memory.retention_days
  eklavya memory import <source.db>     Import a Claude Mem database [--dry-run] [--verify] [--resume]
                                        --dry-run reads the source and reports; it writes nothing
                                        --verify checks every source row by id is here and where each
                                        project was filed; writes nothing, exits 1 if any are missing
                                        --map <source>=<path>  file that source project under a checkout
                                        --map-here <source>    the same, for the checkout you are in
  eklavya memory export <file> [--force]
                                        Versioned JSON of entries, tags, evidence links and receipts,
                                        readable only by you. Refuses to replace a file without --force
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
             max_new_concepts_per_session, max_stop_blocks_per_session, quiet,
             explain_on_wrong,
             auto_update, telemetry (global only)
Config namespaces (nested; edit ~/.eklavya/config.json or this project's file directly):
  quiz.{enabled, enforced} — whether questions happen, and whether they gate
             commits. Separate from memory: silencing questions never stops
             recording. (mode: ambient|enforced|off is the retired spelling,
             still read so older configs keep working)
  memory.{enabled, capture: full|minimal|off, batch_max_events, retention_days}
  privacy.{exclude_paths, exclude_tools, redact_patterns}
  retrieval.{mode: keyword|semantic|hybrid, max_items, max_tokens, cross_project}
  providers.{observer, embeddings} — each null or {kind, model}; the model runs
             through Claude Code on your subscription
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
    if (resolved.ignored.length) {
      process.stdout.write(
        `ignored in the project file (global-only, set them without --project): ${resolved.ignored.join(', ')}\n`,
      );
    }
    // Defaults are standing in for a file that would not parse; say so, or the
    // output above reads as the developer's settings when it is not.
    const problem = configFileProblem();
    if (problem) process.stderr.write(`warning: ${problem}\n`);
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

  try {
    writeConfigFile(target, patch);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  for (const [k, v] of Object.entries(patch)) {
    process.stdout.write(`${k} = ${JSON.stringify(v)}  ->  ${target}\n`);
  }
  if (modeNote) process.stdout.write(`${modeNote}\n`);
}

/**
 * `eklavya telemetry`: the anonymous usage ping, in the open. `show` prints the
 * next ping exactly as `send` would post it, so the docs' claim that it holds
 * only counts and setting values can be checked by anyone.
 */
async function telemetryCommand(args: string[]): Promise<void> {
  const [sub = 'status', ...flags] = args;
  const t = await import('./telemetry.js');
  if (sub === 'on' || sub === 'off') {
    const file = loadConfig().globalPath;
    writeConfigFile(file, { telemetry: sub === 'on' });
    process.stdout.write(`telemetry = ${sub === 'on'}  ->  ${file}\n`);
    const still = t.disabledReason();
    if (sub === 'on' && still) process.stdout.write(`${dim(`still off: ${still}`)}\n`);
    return;
  }
  if (sub === 'show' || sub === 'send') {
    const [{ openDb }, send] = await Promise.all([import('./db.js'), import('./telemetry-send.js')]);
    const db = openDb();
    try {
      if (sub === 'show') {
        const events = send.buildEvents(db);
        send.assertSafe(events);
        process.stdout.write(`${JSON.stringify({ client_id: t.installId(), events }, null, 2)}\n`);
        return;
      }
      const ok = await send.sendNow(db);
      if (!flags.includes('--background')) process.stdout.write(ok ? 'sent\n' : `not sent${t.disabledReason() ? ` (${t.disabledReason()})` : ''}\n`);
    } finally {
      db.close();
    }
    return;
  }
  if (sub !== 'status') {
    process.stderr.write('Usage: eklavya telemetry [status|on|off|show]\n');
    process.exit(1);
  }
  const off = t.disabledReason();
  const st = t.readState();
  process.stdout.write(
    `${off ? `off (${off})` : 'on'} · anonymous daily usage counts${st.sent_at ? ` · last sent ${st.sent_at}` : ''}\n` +
      `${dim('what is sent: eklavya telemetry show · https://eklavya-run.web.app/docs/usage-analytics/')}\n` +
      `${dim(off ? 'turn on: eklavya telemetry on' : 'turn off: eklavya telemetry off')}\n`,
  );
}

/** Never throws: `doctor` is also what someone runs on a half-built database. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function doctor(): Promise<void> {
  // Loaded here rather than at the top of the file: see the note on the imports.
  const [
    { openDb },
    { applyPacks, loadPacks },
    { health, commandOnPath, eklavyaGateHook },
    { countEntries, pendingEventCount },
    { queueDepth },
    { syncStatus },
    { droppedCount },
    { workerLine },
  ] = await Promise.all([
    import('./db.js'),
    import('./packs.js'),
    import('./install.js'),
    import('./memory/store.js'),
    import('./memory/worker.js'),
    import('./memory/sync.js'),
    import('./memory/spool.js'),
    import('./cli-memory.js'),
  ]);
  const file = dbPath();
  // `doctor` is where somebody goes when something is not taking effect, so it
  // is the second place the legacy move runs -- a settings file still sitting
  // in the checkout is exactly that complaint.
  const repoHere = findRepoConfig().repoRoot;
  if (repoHere) migrateLegacyRepoConfig(repoHere, mainRepoRoot(repoHere));
  const resolved = loadConfig();
  const rows: Array<[Mark, string, string]> = [];
  const add = (mark: Mark, label: string, detail: string) => rows.push([mark, label, detail]);
  let ok = true;
  // Kept apart from `ok` so the blanket remedy below stays true: `eklavya
  // install` repairs a broken install and cannot do a thing about a paused
  // queue. A memory failure still exits non-zero; it just names its own fix.
  let memoryOk = true;
  // Its own flag for the same reason: `eklavya install` does not put jq or
  // sqlite3 on anybody's PATH, and a config file only its owner can fix.
  let fixByHand = true;
  // And one more: `eklavya install` does not fix a failing update -- the
  // update's own error says what does, and `eklavya update` shows it live.
  let updatesOk = true;

  add('ok', 'home', eklavyaHome());

  // The install checks come first because they are what someone is looking for
  // when Eklavya has gone quiet. Everything below reads fine on an install that
  // Claude Code can no longer load at all.
  const checks = health();
  for (const check of checks) {
    if (!check.ok) ok = false;
    add(check.ok ? 'ok' : 'fail', check.name, `${check.ok ? '' : 'FAILED — '}${check.detail}`);
  }

  // The auto-updater, read from its state file. The error is shown however it
  // was classed: `doctor` is where somebody goes when the session line said
  // updates are failing, and an offline week is still a week without them.
  {
    const { autoUpdateEnabled, readState, runtimeVersion, logPath } = await import('./update.js');
    const u = safely(() => readState(), {});
    const on = safely(() => autoUpdateEnabled(), true);
    const last = u.ok_at ? `last succeeded ${u.ok_at}` : 'has not run yet';
    add(
      on ? 'ok' : 'skip',
      'updates',
      `${on ? 'automatic' : 'off (auto_update is false) — run eklavya update by hand'} · runtime ${runtimeVersion() ?? 'not installed'}${
        u.latest ? ` · latest ${u.latest}` : ''
      } ${dim(`(${last})`)}`,
    );
    if (u.error) {
      updatesOk = false;
      add('fail', 'updates', `FAILED — ${u.error}${u.checked_at ? ` ${dim(`(${u.checked_at})`)}` : ''}`);
      add('fail', 'updates', dim(`run eklavya update to retry and see why; the last background run is in ${logPath()}`));
    }
  }

  // The usage ping. Not a failure either way: off is a choice, and a ping
  // that did not go out costs the maintainer a count, not the developer anything.
  {
    const t = await import('./telemetry.js');
    const off = safely(() => t.disabledReason(), null);
    const sent = safely(() => t.readState().sent_at, undefined);
    add(
      off ? 'skip' : 'ok',
      'usage ping',
      `${off ? `off (${off})` : 'on — anonymous daily counts, eklavya telemetry show prints them'}${sent ? ` ${dim(`(last sent ${sent})`)}` : ''}`,
    );
  }

  // Which surfaces the checks above actually cover. The `plugin` check reads
  // Claude Code's registry under `~/.claude`, which the Code tab in Claude
  // Desktop shares — so one OK covers both. Cowork keeps its own registry
  // inside the app's data directory and is installed from its own UI, so a
  // green doctor says nothing about it. Someone whose Cowork sessions are
  // silent needs to be told that here, not left reading a clean report.
  add('ok', 'surfaces', 'Claude Code CLI and the Code tab in Claude Desktop (checked above)');
  add('skip', 'cowork', dim('keeps a separate plugin list — install it there from Customize → Plugins;'));
  add('skip', 'cowork', dim('this command cannot see it. Your learning history is shared either way.'));

  // `openDb` below creates a missing file, so the row says what happened, not
  // what was true a moment before it happened.
  const dbExisted = fs.existsSync(file);
  const dbRow = rows.length;
  add(dbExisted ? 'ok' : 'warn', 'database', `${file}${dbExisted ? '' : dim('   (does not exist)')}`);

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
    if (!dbExisted) rows[dbRow] = ['ok', 'database', `${file} ${dim('(created now — it did not exist)')}`];
    edgesDropped = applyPacks(db).edgesDropped;
    const concepts = (db.prepare('SELECT count(*) n FROM concepts').get() as { n: number }).n;
    const attempts = (db.prepare('SELECT count(*) n FROM attempts').get() as { n: number }).n;
    const known = (
      db.prepare('SELECT count(*) n FROM mastery WHERE score >= 0.7 AND reps >= 2').get() as { n: number }
    ).n;
    add('ok', 'concepts', String(concepts));
    add('ok', 'attempts', String(attempts));
    add('ok', 'mastered', String(known));
    add('ok', 'journal', String(db.pragma('journal_mode', { simple: true })));
    // The project's band, and the runway left in it. Read here because `doctor`
    // is where someone looks when the questions feel wrong for them.
    const standing = levelStanding(db, resolved.config, resolved.repoRoot);
    add(
      'ok',
      'level',
      `${standing.level} ${dim(
        standing.pinned
          ? '(pinned by config — no progression)'
          : `(${standing.counts.passed}/${standing.needed.answers} passing answers in ${standing.repo})`,
      )}`,
    );
  } catch (err) {
    ok = false;
    add('fail', 'database', `FAILED — ${err instanceof Error ? err.message : String(err)}`);
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
    add(
      'fail',
      'conflict',
      'FAILED — quiz.enabled is false and quiz.enforced is true. A gate needs ' +
        'passed questions and nothing will ask any, so the enforcement is being ignored ' +
        'rather than blocking every commit. Set quiz.enabled true to gate commits, or drop ' +
        'quiz.enforced to accept the silence.',
    );
  }

  const memory = resolved.config.memory;
  add(memory.enabled ? 'ok' : 'skip', 'memory', memory.enabled ? `on · capture ${memory.capture}` : 'off (memory.enabled is false)');

  if (db) {
    const entries = safely(() => countEntries(db!), 0);
    const evidence = safely(
      () => (db!.prepare('SELECT count(*) n FROM evidence_events').get() as { n: number }).n,
      0,
    );
    const waiting = safely(() => pendingEventCount(db!), 0);
    add('ok', 'memory', `${entries} entries, ${evidence} evidence events ${dim(`(${waiting} not yet summarised)`)}`);

    const queue = safely(() => queueDepth(db!), { pending: 0, paused: 0, failed: 0, quarantined: 0, oldest: null });
    add('ok', 'memory', `queue ${queue.pending} pending · ${queue.paused} paused · ${queue.failed} failed`);
    add('ok', 'memory', `worker ${safely(() => workerLine(db!), 'unknown')}`);

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
      const paused = classes('paused');
      add('fail', 'memory', `FAILED — ${queue.paused} job(s) paused (${paused}); nothing is being summarised`);
      const fixes = [
        paused.includes('missing') && 'put claude on the PATH Claude Code starts with (an app or IDE launch often has a shorter one)',
        paused.includes('auth') && 'log in to Claude Code (claude, then /login)',
        paused.includes('quota') && 'wait out the usage limit',
      ].filter(Boolean);
      add('fail', 'memory', dim(`${fixes.join(', or ') || 'fix what paused it'}, then: eklavya memory process`));
    }
    if (queue.failed > 0) {
      // Not a failure: a permanently failed job is a batch that will never
      // summarise, and no command repairs it. Saying so beats a clean report.
      add('warn', 'memory', `${queue.failed} job(s) failed permanently (${classes('failed')})`);
    }

    // The capture heartbeat: memory that is "on" with nothing arriving is the
    // failure the entry count alone cannot show.
    const newest = safely(
      () => (db!.prepare('SELECT MAX(occurred_at) AS at FROM evidence_events').get() as { at: string | null }).at,
      null as string | null,
    );
    add('ok', 'memory', `last evidence ${newest ?? '— none captured yet'}`);

    const sync = safely(() => syncStatus(db!, resolved.config), null);
    add('ok', 'memory', `sync ${sync?.enabled ? `on -> ${sync.target ?? '(no target set — set sync.target)'}` : 'off'}`);
  }

  const dropped = safely(() => droppedCount(), 0);
  if (dropped > 0) {
    // Dropped, not spooled: these events never reached the database *or* the
    // spool file, so nothing replays them on its own. The transcripts are the
    // only remaining copy.
    memoryOk = false;
    add('fail', 'memory', `FAILED — ${dropped} event(s) dropped before they reached the database`);
    add('fail', 'memory', dim('recover them from this checkout’s transcripts with: eklavya memory replay'));
  }
  add(
    'ok',
    'memory',
    `provider ${resolved.config.providers.observer ? 'configured — batches leave this machine' : 'none — nothing leaves this machine'}`,
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
  const from = (key: string) => (projectKeys.has(key) ? dim(' (set for this project)') : '');
  const q = resolved.config.quiz;
  add(
    q.enabled ? 'ok' : 'skip',
    'quiz',
    `${q.enabled ? 'on' : 'off — memory is unaffected'}${
      q.enforced ? ' · enforced (commits gated)' : ''
    }${from('quiz')}`,
  );
  add(
    'ok',
    'focus',
    `${resolved.config.focus}${
      resolved.config.focus === 'learn' ? ` (${resolved.config.focus_topic ?? 'no topic set'})` : ''
    }${from('focus')}`,
  );
  add(
    'ok',
    'cadence',
    `${resolved.config.cadence} ${dim(
      resolved.config.cadence === 'interleaved'
        ? `(one question mid-task, min ${resolved.config.min_minutes_between_checkpoints}m apart)`
        : '(all questions at the end of the task)',
    )}${from('cadence')}`,
  );
  if (resolved.overrides.length > 0) {
    add('warn', 'overrides', `for this project: ${resolved.overrides.join(', ')}`);
  }
  if (resolved.projectPath) add('ok', 'project', resolved.projectPath);

  // A settings file that stopped parsing is read as absent, so every dial
  // above is a default wearing the developer's name. Only `doctor` says so.
  const configProblem = safely(() => configFileProblem(), null);
  if (configProblem) {
    fixByHand = false;
    add('fail', 'config', `FAILED — ${configProblem}`);
  }

  // The terminal gate (`cli/eklavya-gate`) shells out to jq and sqlite3 and
  // fails OPEN without either: every commit goes through, and the only trace
  // is one stderr line per commit. Installed here, that is a gate that is not
  // gating; enforced with no terminal hook, it is a warning for later.
  const gateHook = safely(() => eklavyaGateHook(), null);
  if (gateHook) add('ok', 'git hook', gateHook);
  if (gateHook || q.enforced) {
    const missing = ['jq', 'sqlite3'].filter((tool) => !commandOnPath(tool));
    if (missing.length && gateHook) {
      fixByHand = false;
      add('fail', 'gate', `FAILED — ${missing.join(' and ')} not on PATH; the commit gate lets every commit through`);
    } else if (missing.length) {
      add('warn', 'gate', `${missing.join(' and ')} not on PATH ${dim('— the terminal commit gate needs them if you install it')}`);
    }
  }

  // Packs, and the one place a broken one is visible. `loadPacks` never throws
  // -- a malformed file in ~/.eklavya/packs/ makes one pack unavailable, not
  // Eklavya -- so without this line the failure is a domain that quietly never
  // shows up.
  const packs = loadPacks();
  if (packs.length > 0) {
    const good = packs.filter((p) => p.pack);
    add(
      'ok',
      'packs',
      `${good.length} loaded${
        good.length > 0
          ? ` — ${good.map((p) => `${p.pack!.pack}${p.pack!.version ? `@${p.pack!.version}` : ''} (${p.scope})`).join(', ')}`
          : ''
      }`,
    );
    if (edgesDropped > 0) {
      // An edge endpoint naming nothing is almost always a typo, and it is
      // silent everywhere else: the pack loads, the concept appears, and the
      // prerequisite it was meant to hang off simply is not there.
      add('warn', 'packs', `${edgesDropped} edge(s) dropped — an endpoint named a slug that does not exist`);
    }
    // The one remaining way an Eklavya file ends up in a checkout, and it only
    // ever got there before the move. Named rather than fixed: a committed pack
    // is authored content somebody reviewed, so relocating it is their call.
    const inRepo = good.filter((p) => p.scope === 'repo');
    if (inRepo.length > 0) {
      add(
        'warn',
        'packs',
        `${inRepo.length} still inside the checkout (${inRepo
          .map((p) => p.pack!.pack)
          .join(', ')}) — they load, but Eklavya no longer writes there;`,
      );
      add('warn', 'packs', dim('move them to ~/.eklavya/projects/<checkout>/packs/ to keep the repo clean'));
    }
    for (const bad of packs.filter((p) => !p.pack)) {
      // Deliberately does NOT set `ok`. A bad pack costs that pack and nothing
      // else, and the blanket remedy below is `eklavya install`, which never
      // touches ~/.eklavya/packs/ and could not repair this if it wanted to.
      add('fail', 'packs', `FAILED — ${bad.file}: ${bad.error}`);
      add('fail', 'packs', dim('fix or delete that file; everything else is unaffected'));
    }
  }

  // One fix for all of them: `install` is idempotent, so re-running it is the
  // repair. Naming it here is the whole point of the checks above — a report
  // nobody can act on is worse than no report.
  heading('eklavya doctor');
  // A label is said once, and its glyph again only when the state changes: a run
  // of rows under one label reads as a block, and a failure inside it still shows.
  rows.forEach(([mark, label, detail], i) => {
    const prev = rows[i - 1];
    const same = prev?.[1] === label;
    check(same && prev[0] === mark ? null : mark, same ? '' : label, detail);
  });
  verdict(
    !ok
      ? 'Something is broken. Run: eklavya install'
      : !memoryOk
        ? 'Memory needs attention — see above'
        : !fixByHand
          ? 'Needs a fix by hand — see above'
          : !updatesOk
            ? 'Updates are failing. Run: eklavya update'
            : null,
    'ALL CLEAR · Eklavya is wired up',
  );
  if (!ok || !memoryOk || !fixByHand || !updatesOk) process.exit(1);
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

async function dashboardCommand(argv: string[]): Promise<void> {
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

  const [{ openDb }, { startDashboard, openInBrowser }] = await Promise.all([
    import('./db.js'),
    import('./dashboard.js'),
  ]);
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
 * `eklavya artifacts`: the file side of the eklavya-artifacts skill and the
 * explainer agent. `new` is the one place a page's path and metadata are
 * decided, so a model never has to work out the project folder itself.
 */
async function artifactsCommand(argv: string[]): Promise<void> {
  const { createArtifact, listArtifacts, resolveArtifact, artifactProject } = await import('./artifacts.js');
  const [sub, ...rest] = argv;
  if (sub === 'new') {
    // `parseArgs` rather than a hand loop: an agent writes `--kind=explainer`
    // as often as `--kind explainer`, and a flag that is silently dropped
    // files the page under the wrong kind. Unknown flags and missing values
    // fail loudly; `--` ends the flags, for a title that starts with dashes.
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          description: { type: 'string' },
          kind: { type: 'string' },
          concept: { type: 'string' },
          open: { type: 'boolean' },
        },
      });
    } catch (err) {
      fail(`eklavya artifacts new: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { values, positionals } = parsed;
    const title = positionals.join(' ').trim();
    if (!title) fail('eklavya artifacts new: give the page a title');
    const kind = values.kind ?? 'artifact';
    if (kind !== 'artifact' && kind !== 'explainer') fail('eklavya artifacts new: --kind is artifact or explainer');
    const made = createArtifact({ title, description: values.description, kind, concept: values.concept ?? null });
    process.stdout.write(`${made.path}\n`);
    if (values.open) (await import('./dashboard.js')).openInBrowser(made.path);
    return;
  }
  if (sub === 'list') {
    const here = rest.includes('--here') ? artifactProject() : null;
    const rows = listArtifacts().filter((r) => !here || r.project === here);
    if (rest.includes('--json')) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (!rows.length) {
      process.stdout.write('No artifacts yet.\n');
      return;
    }
    for (const r of rows) {
      process.stdout.write(`${new Date(r.created).toLocaleDateString('en-CA')}  ${r.kind === 'explainer' ? 'explainer' : 'artifact '}  ${r.title}\n`);
      process.stdout.write(`            ${path.join(eklavyaHome(), 'artifacts', r.id)}\n`);
    }
    return;
  }
  if (sub === 'open') {
    const target = rest[0];
    if (!target) fail('eklavya artifacts open: name the file or its id');
    // A path the caller already has, or an id from `list --json`.
    const file = fs.existsSync(target) ? path.resolve(target) : resolveArtifact(target);
    if (!file) fail(`eklavya artifacts open: no artifact at ${target}`);
    (await import('./dashboard.js')).openInBrowser(file);
    process.stdout.write(`${file}\n`);
    return;
  }
  fail('Usage: eklavya artifacts new <title> | list [--json] [--here] | open <path|id>');
}

/**
 * `eklavya update`: the background updater's run, in the foreground. With
 * `--background` it is the run the SessionStart hook starts: nobody is
 * watching, so everything goes to `update.log` instead.
 */
async function updateCommand(argv: string[]): Promise<void> {
  const { runUpdate } = await import('./update.js');
  const background = argv.includes('--background');
  if (!background) heading('eklavya update');
  const result = await runUpdate({ background, say: background ? undefined : (line) => check(null, '', dim(line)) });
  if (background) return;
  switch (result.status) {
    case 'updated':
      verdict(null, `updated ${result.from ?? 'nothing'} → ${result.to} · new sessions load it`);
      return;
    case 'current':
      verdict(null, `up to date · ${result.version}`);
      return;
    case 'busy':
      verdict('an update is already running · try again in a few minutes', '');
      return;
    case 'skipped':
      return;
    case 'failed':
      verdict(`could not update · ${result.error}`, '');
      process.exitCode = 1;
  }
}

/**
 * Runs the runtime's CLI instead of this one when the runtime is newer.
 *
 * The global `eklavya` is installed by `npm install -g` and only moves when
 * somebody runs that again; the runtime updates itself. So a global binary
 * that hands off to a newer runtime is never stale, and updating needs no
 * sudo, no npm and no memory of having to. `EKLAVYA_FORWARDED` stops a loop;
 * the runtime's own `cli.js` is never forwarded, since it is the target.
 */
async function forwardToNewerRuntime(): Promise<boolean> {
  if (process.env.EKLAVYA_FORWARDED) return false;
  const { runtimeCli, runtimeVersion, compareVersions } = await import('./update.js');
  const target = runtimeCli();
  const own = path.join(moduleDir, 'cli.js');
  let ownVersion: string;
  try {
    if (fs.realpathSync(target) === fs.realpathSync(own)) return false;
    ownVersion = JSON.parse(fs.readFileSync(path.join(moduleDir, '..', 'package.json'), 'utf8')).version;
  } catch {
    return false;
  }
  const theirs = runtimeVersion();
  if (!theirs || compareVersions(theirs, ownVersion) <= 0) return false;
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, EKLAVYA_FORWARDED: '1' },
  });
  if (child.error) return false;
  process.exit(child.status ?? 1);
}

const COUNTED = new Set([
  'install', 'update', 'export-rules', 'config', 'dashboard', 'memory', 'artifacts', 'doctor', 'db-path', 'telemetry',
]);

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // The command's name only, for the usage ping; never its arguments. Not the
  // server or the status line, which run constantly and say nothing about use,
  // nor uninstall, which sends its own event and must change nothing if it fails.
  if (command && COUNTED.has(command)) (await import('./telemetry.js')).countCommand(`cli:${command}`);
  // Not for `statusline` or `serve`: both are started from the runtime already,
  // and the status bar pays for every millisecond here.
  if (command !== 'statusline' && command !== 'serve' && (await forwardToNewerRuntime())) return;

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
    case 'install': {
      const { install } = await import('./install.js');
      // Async only because the settings walk waits on a terminal.
      install(rest).catch((err: unknown) => {
        process.stderr.write(`eklavya install: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
      return;
    }
    case 'update':
      return updateCommand(rest);
    case 'uninstall': {
      // Before anything is removed: afterwards there is no runtime to send it.
      const { sendOne } = await import('./telemetry-send.js');
      await sendOne('uninstall', { purge: rest.includes('--purge') });
      return (await import('./install.js')).uninstall(rest);
    }
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
      return (await import('./cli-memory.js')).memoryCommand(rest);
    case 'artifacts':
      return artifactsCommand(rest);
    case 'doctor':
      return doctor();
    case 'db-path':
      process.stdout.write(`${dbPath()}\n`);
      return;
    case 'telemetry':
      return telemetryCommand(rest);
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

// Awaited, so an error thrown by a command surfaces exactly as it did when
// `main()` was synchronous: as the module's own failure, stack and exit 1.
await main();
