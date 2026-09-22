#!/usr/bin/env node
/**
 * The `eklavya` CLI: the parts of Eklavya that make sense outside a Claude Code
 * session. The commit gate has its own POSIX script (`cli/eklavya-gate`) because
 * a git hook must not pay Node's startup cost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { dbPath, eklavyaHome } from './paths.js';
import { readStdinBounded, stripBom, STATUSLINE_STDIN } from './stdin.js';
import { loadConfig, writeConfigFile, REPO_CONFIG_FILE, DEFAULT_CONFIG, findRepoConfig } from './config.js';
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
  timeline,
} from './memory/store.js';
import { search, type SearchMode } from './memory/search.js';
import { processPending, pruneEvidence, queueDepth, summarizerFor } from './memory/worker.js';
import { droppedCount } from './memory/spool.js';
import { savingsFrom, savingsLine } from './memory/tokens.js';
import {
  importFrom,
  inventory,
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
  eklavya config set <key> <value>      Change a setting (add --repo to scope it to this repo)
                                        e.g. mode ambient|enforced|off, focus project|concept|learn,
                                        cadence interleaved|end,
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
  eklavya memory process [--max <n>]    Drain the observation queue now
  eklavya memory prune                  Delete raw evidence past memory.retention_days
  eklavya memory import <source.db>     Import a Claude Mem database [--dry-run] [--resume]
                                        --dry-run reads the source and reports; it writes nothing
                                        --map <source>=<path>  file that source project under a checkout
                                        --map-here <source>    the same, for the checkout you are in
  eklavya memory export <file>          Versioned JSON of entries, tags, evidence links and receipts

Config keys: mode, focus, focus_topic, cadence, difficulty, level_up_after,
             level_up_accuracy, pass_threshold, max_questions_per_task,
             min_minutes_between_quizzes, min_minutes_between_checkpoints,
             max_new_concepts_per_session, max_stop_blocks_per_session, quiet
Config namespaces (nested; edit ~/.eklavya/config.json or .eklavya.json directly):
  memory.{enabled, capture: full|minimal|off, batch_max_events, retention_days}
  privacy.{exclude_paths, exclude_tools, redact_patterns}
  retrieval.{mode: keyword|semantic|hybrid, max_items, max_tokens, cross_project}
  providers.{observer, embeddings} — each null or {kind, model, api_key_env};
             api_key_env names the variable holding the key, never the key itself
  notifications.{enabled, sinks} — sinks are {kind: webhook|command|file, target,
             args, events}; off by default, and a send cannot be recalled
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
  const [action, key, value] = args;
  const scopeRepo = args.includes('--repo');
  const resolved = loadConfig();

  if (!action || action === 'get') {
    process.stdout.write(`${JSON.stringify(resolved.config, null, 2)}\n`);
    process.stdout.write(`\nglobal: ${resolved.globalPath}\n`);
    process.stdout.write(`repo:   ${resolved.repoPath ?? '(none)'}\n`);
    return;
  }

  if (action !== 'set') fail(`Unknown config action "${action}".`);
  if (!key || value === undefined) fail('Usage: eklavya config set <key> <value>');
  if (!(key in DEFAULT_CONFIG)) {
    fail(`Unknown setting "${key}". Known: ${Object.keys(DEFAULT_CONFIG).join(', ')}`);
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

  // A topic is always a string. Number-parsing it would turn a topic like "html5"
  // -- or worse, "2" -- into something `coerce` then silently drops.
  const isTopicKey = key === 'focus_topic';
  let parsed: unknown = value;
  if (isTopicKey) parsed = value;
  else if (value === 'true' || value === 'false') parsed = value === 'true';
  else if (value !== '' && !Number.isNaN(Number(value))) parsed = Number(value);

  const patch: Record<string, unknown> = { [key]: parsed };
  if (topic !== undefined && key === 'focus') patch.focus_topic = topic;

  let target: string;
  if (scopeRepo) {
    if (!resolved.repoRoot) fail('Not inside a git repository, so there is nowhere to write .eklavya.json.');
    target = resolved.repoPath ?? path.join(resolved.repoRoot, REPO_CONFIG_FILE);
  } else {
    target = resolved.globalPath;
  }

  writeConfigFile(target, patch);
  for (const [k, v] of Object.entries(patch)) {
    process.stdout.write(`${k} = ${JSON.stringify(v)}  ->  ${target}\n`);
  }
}

function doctor(): void {
  const file = dbPath();
  const resolved = loadConfig();
  const lines: string[] = [];
  let ok = true;

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
  try {
    const db = openDb(file);
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
    db.close();
  } catch (err) {
    ok = false;
    lines.push(`database error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const fromRepo = resolved.repoPath ? ' (from this repo)' : '';
  lines.push(`mode:     ${resolved.config.mode}${fromRepo}`);
  lines.push(
    `focus:    ${resolved.config.focus}${
      resolved.config.focus === 'learn' ? ` (${resolved.config.focus_topic ?? 'no topic set'})` : ''
    }${fromRepo}`,
  );
  lines.push(
    `cadence:  ${resolved.config.cadence}${
      resolved.config.cadence === 'interleaved'
        ? ` (one question mid-task, min ${resolved.config.min_minutes_between_checkpoints}m apart)`
        : ' (all questions at the end of the task)'
    }${fromRepo}`,
  );
  if (resolved.overrides.length > 0) {
    lines.push(`overridden by repo: ${resolved.overrides.join(', ')}`);
  }

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
  if (!ok) process.exit(1);
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
 * dials themselves come from `.eklavya.json`, so an install with no database
 * yet — or one that cannot be opened — still shows its dials rather than
 * nothing. The database is consulted in its own try/catch for exactly that
 * reason: a locked or corrupt file costs the level, never the bar.
 */
async function statuslineCommand(argv: string[]): Promise<void> {
  try {
    // Claude Code writes a JSON blob to stdin (cwd, model, session). We want
    // the cwd, so the repo-scoped .eklavya.json is the one that answers.
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
    // dials are still true; only the choice of .eklavya.json was in doubt.
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
        // A silenced session shows no bar. It says the same thing `mode: off`
        // says, and a bar still reciting the dials of a session that will not
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
  'Usage: eklavya memory status|search|timeline|show|process|prune|import|export\n' +
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
  processPending(db, config, { maxJobs: numberFlag(argv, '--max', 10) }).then(
    (result) => {
      process.stdout.write(
        `processed ${result.processed} · entries ${result.entries} · failed ${result.failed} · skipped ${result.skipped}\n`,
      );
      db.close();
    },
    (err: Error) => {
      db.close();
      fail(`eklavya memory process: ${err.message}`);
    },
  );
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
      map[name] = projectKey(findRepoConfig(process.cwd()).repoRoot);
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
    throw err;
  }
}

/** The export format version. Bump it when the shape below changes. */
const EXPORT_SCHEMA_VERSION = 1;

function memoryExport(argv: string[]): void {
  const out = argv.find((a) => !a.startsWith('--'));
  if (!out) fail('Usage: eklavya memory export <path>');

  const db = openDb();
  try {
    const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
    const payload = {
      schema_version: EXPORT_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
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
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(`Wrote ${out} — ${payload.entries.length} entries, schema version ${EXPORT_SCHEMA_VERSION}\n`);
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
    case 'process':
      return memoryProcess(rest);
    case 'prune':
      return memoryPrune();
    case 'import':
      return memoryImport(rest);
    case 'export':
      return memoryExport(rest);
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
