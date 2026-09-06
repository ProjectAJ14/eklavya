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
import { loadConfig, writeConfigFile, REPO_CONFIG_FILE, DEFAULT_CONFIG } from './config.js';
import { levelStanding } from './store.js';
import { statusLine } from './statusline.js';
import { START_LEVEL, type Level } from './srs.js';
import Database from 'better-sqlite3';
import { startDashboard, openInBrowser } from './dashboard.js';
import { install, uninstall, health } from './install.js';

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
  eklavya doctor                        Check the install and say what to fix if it broke
  eklavya db-path                       Print the database location

Config keys: mode, focus, focus_topic, cadence, difficulty, level_up_after,
             level_up_accuracy, pass_threshold, max_questions_per_task,
             min_minutes_between_quizzes, min_minutes_between_checkpoints,
             max_new_concepts_per_session, max_stop_blocks_per_session, quiet
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

  lines.push(`database: ${file}${fs.existsSync(file) ? '' : '   (not created yet)'}`);

  try {
    const db = openDb(file);
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
 * Only the earned level needs the database. The dials themselves come from
 * `.eklavya.json`, and a pinned difficulty *is* the level, so a pinned setup
 * never opens the file at all and an install with no database yet still shows
 * its dials rather than nothing.
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
    // Parsed in its own try: input we cannot read is a reason to fall back to
    // the working directory, not a reason to show the developer nothing. The
    // dials are still true; only the choice of .eklavya.json was in doubt.
    try {
      if (raw.trim()) {
        // Strip a BOM: some Windows shells prepend one, and JSON.parse throws
        // on input that looks perfectly well-formed.
        const parsed: unknown = JSON.parse(stripBom(raw));
        const input = (parsed ?? {}) as { cwd?: string; workspace?: { current_dir?: string } };
        cwd = input.workspace?.current_dir ?? input.cwd ?? cwd;
      }
    } catch {
      /* Unreadable stdin: process.cwd() it is. */
    }

    const resolved = loadConfig(cwd);
    const pinned = resolved.config.difficulty !== 'auto';

    let level: Level = pinned ? (resolved.config.difficulty as Level) : START_LEVEL;
    if (!pinned && fs.existsSync(dbPath())) {
      // `levelStanding` rather than a query of our own: the banner learned this
      // the hard way, and a second implementation of the band rules is a second
      // thing to keep in step with the planner.
      const db = new Database(dbPath(), { readonly: true });
      try {
        level = levelStanding(db, resolved.config, resolved.repoRoot).level;
      } finally {
        db.close();
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
