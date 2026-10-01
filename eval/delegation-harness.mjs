#!/usr/bin/env node
/**
 * The delegation eval: does a session hand its building to a background agent
 * and ask questions while it waits, and does it leave small or docs-only work
 * alone?
 *
 * Every other eval here measures a question or a retrieval. This one measures
 * a whole session, because delegation is a choice the model makes across many
 * turns: a real `claude` run against a scratch repository, with exactly one
 * Eklavya build loaded, its tool calls read back from the stream.
 *
 *   node eval/delegation-harness.mjs run --plugin <dir> --label baseline --trials 3
 *   node eval/delegation-harness.mjs score <run-dir>
 *
 * `run` writes one directory per trial under `--out` (default: a temp dir):
 * the raw stream, the git log of the worktree it built in, and the lint/test
 * result at each stage commit. `score` reads those back and prints metrics, so
 * a metric can be changed and re-scored without paying for the sessions again.
 *
 * Isolation (eval/README.md, "The contamination trap"):
 *   - `--setting-sources project,local` keeps the developer's user settings,
 *     and with them every globally installed plugin and hook, out;
 *   - exactly one `--plugin-dir`, the build under test;
 *   - `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps claude.ai connectors out;
 *   - a fresh `EKLAVYA_HOME` per trial, with its database created before the
 *     session starts -- SessionStart says nothing on a first-ever start, which
 *     would silently drop the very instructions being measured;
 *   - memory, updates, telemetry and the dashboard off in that home.
 * The stream's init event records which plugins actually loaded; `score`
 * rejects a trial that loaded anything else.
 *
 * Questions: `--print` removes AskUserQuestion, so the session is driven over
 * `--input-format stream-json` with `--permission-prompt-tool stdio`, where it
 * is present and arrives here as a `can_use_tool` request. The harness answers
 * with each question's first option (`answered`), so record_attempt and the
 * verdict are observable. Every other request is allowed unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(evalDir, 'fixtures', 'delegation');

const VALUE_FLAGS = new Set(['plugin', 'label', 'trials', 'scenarios', 'parallel', 'out', 'worktree-skill', 'timeout-min', 'model']);
function flag(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  return VALUE_FLAGS.has(name) ? (process.argv[i + 1] ?? dflt) : true;
}
function positionals() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a.slice(2))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Same rules for every staged scenario: the sentences a design-handoff workflow writes. */
const STAGE_RULES =
  "Implement the stages in the handoff's order, one commit (or more) per stage, conventional commits. Before each fix, write a failing test that proves the defect. After every stage run `npm run lint` and `npm test`; all must pass, no exclusions.";

/**
 * `expect`: what a session that follows the contract does.
 *   builder  -- a background implementation agent starts
 *   inline   -- no implementation agent
 *   fallback -- no background builder, and the parent says why it stays inline
 * `wt`: `prepared` makes a sibling worktree before the session; `skill` leaves
 * it to the session (the worktree-session skill, or `git worktree add`).
 */
export const SCENARIOS = {
  open: {
    expect: 'builder',
    wt: 'prepared',
    prompt: (wt) =>
      `In the worktree at ${wt}, add a \`textstats compare a.txt b.txt\` command: it prints each file's counts, the change in each, the words that appear in only one file, and the ten words whose counts changed most. Support \`--json\` for the same data, keep the existing single-file usage working, and handle a missing file with a one-line error and exit code 2. Add tests for the comparison logic and for the command (spawned), and document it in README.md. Run \`npm run lint\` and \`npm test\` and commit when done.`,
  },
  staged: {
    expect: 'builder',
    wt: 'prepared',
    staged: true,
    prompt: (wt) => `Implement HANDOFF.md in the worktree at ${wt} (branch task). ${STAGE_RULES}`,
  },
  'worktree-flow': {
    expect: 'builder',
    wt: 'skill',
    staged: true,
    prompt: () =>
      `Use the worktree-session skill to create a worktree for this task, then implement HANDOFF.md there. ${STAGE_RULES}`,
  },
  docs: {
    expect: 'inline',
    wt: 'prepared',
    prompt: (wt) =>
      `In the worktree at ${wt}, write a design proposal for a \`--top N\` CLI option: docs/design/top-words.md (motivation, CLI shape, edge cases, open questions) and an HTML mockup docs/design/top-words.html showing example terminal output for two inputs. Design only: do not change any code. Commit both files.`,
  },
  tiny: {
    expect: 'inline',
    wt: 'prepared',
    prompt: (wt) =>
      `In the worktree at ${wt}, rename the exported function \`wordCount\` to \`countWords\` everywhere it is used (source and tests), run \`npm test\`, and commit.`,
  },
  inline: {
    expect: 'inline',
    wt: 'prepared',
    staged: true,
    prompt: (wt) =>
      `Implement HANDOFF.md in the worktree at ${wt} (branch task). ${STAGE_RULES} Do the implementation yourself in this conversation; do not hand any of it to subagents.`,
  },
  nobg: {
    expect: 'fallback',
    wt: 'prepared',
    staged: true,
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    prompt: (wt) => `Implement HANDOFF.md in the worktree at ${wt} (branch task). ${STAGE_RULES}`,
  },
};

function sh(cwd, cmd, args, env) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
  return res.stdout;
}
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com' };
const git = (cwd, ...args) => sh(cwd, 'git', args, GIT_ENV);

/** A bare origin, a main checkout cloned from it, and (for `prepared`) a sibling worktree on `task`. */
function makeRepo(trialDir, scenario, skillSrc) {
  const origin = path.join(trialDir, 'origin.git');
  const main = path.join(trialDir, 'textstats');
  git(trialDir, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.cpSync(path.join(fixtureDir, 'project'), main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'chore: initial textstats');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', '-u', 'origin', 'main');
  let wt = null;
  if (scenario.wt === 'prepared') {
    wt = path.join(trialDir, '.textstats-worktrees', 'task');
    git(main, 'worktree', 'add', '-q', '-b', 'task', wt, 'origin/main');
  } else if (skillSrc) {
    // The developer's own worktree skill, as a project skill: user settings are
    // excluded on purpose, and the skill names its script by its user path.
    const dest = path.join(main, '.claude', 'skills', 'worktree-session');
    fs.cpSync(skillSrc, dest, { recursive: true });
    const skill = path.join(dest, 'SKILL.md');
    fs.writeFileSync(
      skill,
      fs.readFileSync(skill, 'utf8').replaceAll('~/.claude/skills/worktree-session', dest),
    );
  }
  return { main, wt };
}

function makeHome(trialDir, plugin) {
  const home = path.join(trialDir, 'eklavya-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ auto_update: false, telemetry: false, dashboard_autostart: false, memory: { enabled: false } }, null, 2),
  );
  const env = { ...process.env, EKLAVYA_HOME: home, EKLAVYA_DB: path.join(home, 'knowledge.db') };
  const dbUrl = pathToFileURL(path.join(plugin, 'mcp', 'dist', 'db.js')).href;
  sh(trialDir, process.execPath, ['--input-type=module', '-e', `const { openDb } = await import(${JSON.stringify(dbUrl)}); openDb().close();`], env);
  return env;
}

/**
 * The developer's side of AskUserQuestion: the first option of every question.
 * Without `answers` the host reports "The user did not answer", the model
 * records a skip, and the verdict -- one of the things measured -- never comes.
 */
function answered(tool, input) {
  if (tool !== 'AskUserQuestion' || !Array.isArray(input?.questions)) return input;
  const answers = {};
  for (const q of input.questions) answers[q.question] = q.options?.[0]?.label ?? '';
  return { ...input, answers };
}

/** One session over stream-json. Resolves when the last result arrives with no background task left. */
function drive({ cwd, prompt, plugin, env, out, timeoutMs, model }) {
  return new Promise((resolve) => {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-hook-events', '--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions',
      '--setting-sources', 'project,local', '--plugin-dir', plugin,
    ];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(out);
    const send = (o) => child.stdin.writable && child.stdin.write(`${JSON.stringify(o)}\n`);
    let pending = 0;
    let buf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
    send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        log.write(`${line}\n`);
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === 'control_request' && o.request?.subtype === 'can_use_tool') {
          send({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { behavior: 'allow', updatedInput: answered(o.request.tool_name, o.request.input) } } });
        }
        if (o.type === 'system' && o.subtype === 'background_tasks_changed') pending = (o.tasks ?? []).length;
        if (o.type === 'result' && pending === 0) child.stdin.end();
      }
    });
    child.stderr.on('data', (d) => log.write(`${JSON.stringify({ type: 'harness_stderr', text: String(d).slice(0, 2000) })}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end(() => resolve({ code, timedOut }));
    });
  });
}

/** Commits on the task branch, and whether lint and tests pass at each. */
function inspectWork(trialDir, main) {
  const list = git(main, 'worktree', 'list', '--porcelain');
  const trees = [...list.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).filter((p) => fs.realpathSync(p) !== fs.realpathSync(main));
  const result = { worktrees: trees, commits: [], mainDirty: git(main, 'status', '--porcelain').trim() !== '' };
  const tree = trees[0];
  if (!tree) return result;
  result.worktree = tree;
  const log = git(tree, 'log', '--reverse', '--format=%H%x09%s', 'origin/main..HEAD').trim();
  const check = path.join(trialDir, 'check');
  for (const line of log ? log.split('\n') : []) {
    const [sha, subject] = line.split('\t');
    git(main, 'worktree', 'add', '-q', '--detach', check, sha);
    const lint = spawnSync('npm', ['run', '-s', 'lint'], { cwd: check, encoding: 'utf8' }).status === 0;
    const test = spawnSync('npm', ['test', '-s'], { cwd: check, encoding: 'utf8' }).status === 0;
    const files = git(check, 'show', '--name-only', '--format=', sha).trim().split('\n').filter(Boolean);
    git(main, 'worktree', 'remove', '--force', check);
    result.commits.push({ sha, subject, lint, test, files });
  }
  result.dirty = git(tree, 'status', '--porcelain').trim() !== '';
  return result;
}

async function runCommand() {
  const plugin = path.resolve(flag('plugin') ?? fail('--plugin <eklavya checkout with mcp/dist> is required'));
  if (!fs.existsSync(path.join(plugin, 'mcp', 'dist', 'db.js'))) fail(`${plugin}/mcp/dist is missing. Build it first.`);
  const label = flag('label', 'run');
  const trials = Number(flag('trials', '3'));
  const names = (flag('scenarios') ?? Object.keys(SCENARIOS).join(',')).split(',');
  const parallel = Number(flag('parallel', '3'));
  const timeoutMs = Number(flag('timeout-min', '30')) * 60_000;
  const skillFlag = flag('worktree-skill', path.join(os.homedir(), '.claude', 'skills', 'worktree-session'));
  const skillSrc = fs.existsSync(path.join(skillFlag, 'SKILL.md')) ? skillFlag : null;
  const outDir = path.resolve(flag('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), `delegation-${label}-`)));
  fs.mkdirSync(outDir, { recursive: true });
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: plugin, encoding: 'utf8' }).stdout.trim() || 'not a git checkout';
  const version = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const host = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(
    path.join(outDir, 'run.json'),
    JSON.stringify({ label, plugin, revision, version, host, trials, scenarios: names, model: flag('model') ?? 'host default', worktreeSkill: skillSrc ? 'developer skill copied as a project skill' : 'none: the session uses git worktree add', started: new Date().toISOString() }, null, 2),
  );

  const jobs = [];
  for (const name of names) for (let t = 1; t <= trials; t++) jobs.push({ name, t });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { name, t } = jobs[next++];
      const scenario = SCENARIOS[name] ?? fail(`unknown scenario ${name}`);
      const trialDir = path.join(outDir, `${name}-${t}`);
      fs.rmSync(trialDir, { recursive: true, force: true });
      fs.mkdirSync(trialDir, { recursive: true });
      const { main, wt } = makeRepo(trialDir, scenario, skillSrc);
      const env = { ...makeHome(trialDir, plugin), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...(scenario.env ?? {}) };
      const started = Date.now();
      process.stderr.write(`start ${name}-${t}\n`);
      const res = await drive({ cwd: main, prompt: scenario.prompt(wt), plugin, env, out: path.join(trialDir, 'stream.jsonl'), timeoutMs, model: flag('model') });
      const work = inspectWork(trialDir, main);
      const db = path.join(env.EKLAVYA_HOME, 'knowledge.db');
      const meta = spawnSync('sqlite3', ['-json', db, "SELECT key, value FROM meta WHERE key LIKE 'delegate%'"], { encoding: 'utf8' }).stdout;
      fs.writeFileSync(
        path.join(trialDir, 'trial.json'),
        JSON.stringify({ scenario: name, trial: t, main, wt, ...res, seconds: Math.round((Date.now() - started) / 1000), work, meta: meta.trim() ? JSON.parse(meta) : [] }, null, 2),
      );
      process.stderr.write(`done  ${name}-${t} in ${Math.round((Date.now() - started) / 1000)}s${res.timedOut ? ' (timed out)' : ''}\n`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  process.stdout.write(`${outDir}\n`);
}

// ---------------------------------------------------------------- scoring

/** Agents that never build, whatever they do. */
const NON_BUILDERS = /^(Explore|Plan|claude-code-guide|statusline-setup)$|eklavya-(tutor|explainer)/;
/** A Bash command that writes files. Heuristic, and the reason `score` keeps the raw counts. */
const BASH_WRITE = /(^|[;&|\s])(sed\s+-i|perl\s+-[a-z]*i|tee\s|cat\s*>|cat\s*<<|printf[^|;&]*>|echo[^|;&]*>|python3?\s+-\s*<<|node\s+-e|mv\s|cp\s|git\s+apply|patch\s)/;
const isAgentTool = (name) => name === 'Agent' || name === 'Task';
const WITHIN = 3;

/** Reads a stream back into parent events, agent calls and subagent work. */
export function parseStream(lines) {
  const parent = []; // { i, kind, name, input, text, id }
  const sub = new Map(); // parent tool_use_id -> mutating call count
  const done = new Map(); // tool_use_id -> index of its completion
  const hooks = [];
  let init = null;
  let failed = false;
  let pos = 0;
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    pos++;
    if (o.type === 'system' && o.subtype === 'init' && !init) init = o;
    // A usage or spend limit ends the session with an error result, often seconds in.
    if (o.type === 'result' && o.is_error) failed = true;
    if (o.type === 'system' && o.subtype === 'task_notification' && o.tool_use_id) done.set(o.tool_use_id, { pos, status: o.status });
    if (o.type === 'system' && /^hook_/.test(o.subtype ?? '')) hooks.push({ pos, ...o });
    if (o.type === 'user' && !o.parent_tool_use_id && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === 'tool_result') {
          const call = parent.find((p) => p.id === c.tool_use_id);
          if (call) call.result = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          // A foreground agent finishes when its result comes back.
          if (call && isAgentTool(call.name) && !done.has(c.tool_use_id)) done.set(c.tool_use_id, { pos, status: 'returned' });
        }
      }
    }
    if (o.type !== 'assistant') continue;
    for (const c of o.message?.content ?? []) {
      if (o.parent_tool_use_id) {
        if (c.type === 'tool_use' && isMutation(c.name, c.input)) sub.set(o.parent_tool_use_id, (sub.get(o.parent_tool_use_id) ?? 0) + 1);
        continue;
      }
      if (c.type === 'tool_use') parent.push({ pos, kind: 'tool', name: c.name, input: c.input ?? {}, id: c.id });
      else if (c.type === 'text' && c.text.trim()) parent.push({ pos, kind: 'text', text: c.text });
    }
  }
  return { parent, sub, done, hooks, init, failed };
}

function isMutation(name, input) {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return true;
  return name === 'Bash' && BASH_WRITE.test(String(input?.command ?? '')) && !/^\s*git\s+(commit|add)\b/.test(String(input?.command ?? ''));
}

const STAGES = [1, 2, 3, 4];

export function scoreTrial(trial, lines) {
  const s = SCENARIOS[trial.scenario];
  const { parent, sub, done, hooks, init, failed } = parseStream(lines);
  const tools = parent.filter((p) => p.kind === 'tool');
  const plugins = (init?.plugins ?? []).filter((p) => p.path !== 'builtin').map((p) => p.name);
  const nudgeHook = hooks.find((h) => /delegat|This task now edits|edits more than one file/i.test(JSON.stringify(h.output ?? h.stdout ?? h)) && /PostToolUse/.test(JSON.stringify(h)));
  const nudgePos = nudgeHook?.pos ?? null;
  const nudged = Boolean(nudgeHook) || trial.meta.some((r) => r.key.startsWith('delegate_nudge:') && r.value.includes('"done":true'));

  const agents = tools.filter((p) => isAgentTool(p.name));
  const builders = agents.filter((a) => !NON_BUILDERS.test(String(a.input.subagent_type ?? '')) && (sub.get(a.id) ?? 0) > 0);
  const bgBuilders = builders.filter((a) => a.input.run_in_background === true);
  const first = bgBuilders[0] ?? null;
  const parentWrites = (beforePos) => tools.filter((p) => p.pos < beforePos && isMutation(p.name, p.input)).length;
  const wt = trial.work.worktree ? fs.realpathSync.native?.(trial.work.worktree) ?? trial.work.worktree : trial.wt;
  const wtNames = [trial.work.worktree, trial.wt, wt].filter(Boolean);

  // Questions asked while a background builder was running.
  const asks = tools.filter((p) => p.name === 'AskUserQuestion');
  const running = (pos) => bgBuilders.some((b) => b.pos < pos && pos < (done.get(b.id)?.pos ?? Infinity));
  const asksWhile = asks.filter((a) => running(a.pos));
  const recorded = asksWhile.filter((a) => tools.some((p) => /record_attempt$/.test(p.name) && p.pos > a.pos && p.pos < (asks.find((n) => n.pos > a.pos)?.pos ?? Infinity)));
  const verdicts = recorded.filter((a) => {
    const rec = tools.find((p) => /record_attempt$/.test(p.name) && p.pos > a.pos);
    const text = parent.find((p) => p.kind === 'text' && p.pos > rec.pos);
    return text && /\b(correct|right|wrong|not quite|incorrect|the answer (is|was))\b/i.test(text.text);
  });

  const briefs = bgBuilders.map((b) => String(b.input.prompt ?? ''));
  // One stage at a time, read from behaviour rather than brief wording (a stage
  // 2 brief rightly says "stage 1 is committed"): more than one builder, and the
  // parent committed between each launch and the next.
  const parentCommits = tools.filter((p) => p.name === 'Bash' && /git\b[^|;&]*\bcommit\b/.test(String(p.input.command)));
  const stagedOneAtATime =
    bgBuilders.length > 1 &&
    bgBuilders.slice(1).every((b, i) => parentCommits.some((c) => c.pos > bgBuilders[i].pos && c.pos < b.pos));
  const commits = trial.work.commits ?? [];
  const tagged = commits.map((c) => /\[stage ([1-4])\]/i.exec(c.subject)?.[1]).filter(Boolean).map(Number);
  // Who ran `git commit`: a subagent's Bash calls are not in `tools`.
  const parentCommitted = tools.some((p) => p.name === 'Bash' && /git\b[^|;&]*\bcommit\b/.test(String(p.input.command)));
  const textBeforeFirstWrite = parent.filter((p) => p.kind === 'text' && p.pos < (tools.find((t) => isMutation(t.name, t.input))?.pos ?? Infinity)).map((p) => p.text).join('\n');
  const fallbackText = parent.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');

  return {
    scenario: trial.scenario,
    trial: trial.trial,
    valid: plugins.length === 1 && !trial.timedOut && !failed,
    failed,
    plugins,
    timedOut: trial.timedOut,
    seconds: trial.seconds,
    parentTools: tools.length,
    nudged,
    builder: bgBuilders.length > 0,
    foregroundBuilder: builders.length > bgBuilders.length,
    builders: bgBuilders.length,
    parentWritesBeforeBuilder: first ? parentWrites(first.pos) : null,
    parentWritesTotal: parentWrites(Infinity),
    builderWithinNudge: nudgePos && first ? tools.filter((p) => p.pos > nudgePos && p.pos < first.pos).length < WITHIN : null,
    builderBeforeNudge: nudgePos && first ? first.pos < nudgePos : null,
    briefNamesWorktree: first ? briefs.every((t) => wtNames.some((w) => t.includes(w))) : null,
    briefNamesChecks: first ? briefs.every((t) => /npm (run )?lint/.test(t) && /npm test/.test(t)) : null,
    stageAtATime: s.staged && first ? stagedOneAtATime : null,
    asks: asks.length,
    asksWhileBuilding: asksWhile.length,
    recordedWhileBuilding: recorded.length,
    verdictWhileBuilding: verdicts.length,
    commits: commits.length,
    stageCommitsInOrder: s.staged ? tagged.every((n, i) => i === 0 || n >= tagged[i - 1]) && STAGES.every((n) => tagged.includes(n)) : null,
    stageChecksPass: s.staged ? commits.length > 0 && commits.every((c) => c.lint && c.test) : null,
    parentCommitted,
    mainCheckoutTouched: trial.work.mainDirty,
    fallbackVisible:
      s.expect === 'fallback'
        ? /\b(background|subagent|agent)s?\b/i.test(fallbackText) && /\b(unavailable|not available|disabled|can(no|')t|inline|myself|directly)\b/i.test(fallbackText)
        : null,
    firstText: textBeforeFirstWrite.slice(0, 400),
  };
}

function summarize(rows) {
  const by = {};
  for (const r of rows) (by[r.scenario] ??= []).push(r);
  const out = {};
  for (const [name, rs] of Object.entries(by)) {
    const v = rs.filter((r) => r.valid);
    const count = (k) => `${v.filter((r) => r[k] === true).length}/${v.filter((r) => r[k] !== null).length}`;
    out[name] = {
      expect: SCENARIOS[name].expect,
      trials: rs.length,
      valid: v.length,
      nudged: count('nudged'),
      builder: count('builder'),
      foregroundBuilder: count('foregroundBuilder'),
      builderWithinNudge: count('builderWithinNudge'),
      builderBeforeNudge: count('builderBeforeNudge'),
      parentWritesBeforeBuilder: v.map((r) => r.parentWritesBeforeBuilder),
      parentWritesTotal: v.map((r) => r.parentWritesTotal),
      briefNamesWorktree: count('briefNamesWorktree'),
      briefNamesChecks: count('briefNamesChecks'),
      stageAtATime: count('stageAtATime'),
      askedWhileBuilding: `${v.filter((r) => r.asksWhileBuilding > 0).length}/${v.length}`,
      recordedWhileBuilding: `${v.filter((r) => r.recordedWhileBuilding > 0).length}/${v.length}`,
      verdictWhileBuilding: `${v.filter((r) => r.verdictWhileBuilding > 0).length}/${v.length}`,
      stageCommitsInOrder: count('stageCommitsInOrder'),
      stageChecksPass: count('stageChecksPass'),
      parentCommitted: count('parentCommitted'),
      mainCheckoutTouched: count('mainCheckoutTouched'),
      fallbackVisible: count('fallbackVisible'),
      minutes: v.map((r) => Math.round(r.seconds / 60)),
    };
  }
  return out;
}

function scoreCommand() {
  const [dir] = positionals().slice(1);
  if (!dir) fail('usage: score <run-dir>');
  const rows = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const tj = path.join(dir, name, 'trial.json');
    if (!fs.existsSync(tj)) continue;
    const trial = JSON.parse(fs.readFileSync(tj, 'utf8'));
    const lines = fs.readFileSync(path.join(dir, name, 'stream.jsonl'), 'utf8').split('\n');
    rows.push(scoreTrial(trial, lines));
  }
  const run = fs.existsSync(path.join(dir, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) : {};
  const result = { run, metrics: METRICS, summary: summarize(rows), trials: rows };
  fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}

/** What each number means; copied into every result so a reader needs no source. */
const METRICS = {
  valid: 'exactly one non-builtin plugin loaded (the build under test), the session finished inside the timeout, and no result reported an error (a usage limit ends a session that way)',
  nudged: 'the second-file delegation nudge fired (hook event in the stream, or its done row in meta)',
  builder: 'the parent started an Agent/Task call with run_in_background: true whose subagent made at least one write (Edit/Write/MultiEdit/NotebookEdit, or a Bash command matching the write heuristic); Explore, Plan, claude-code-guide, statusline-setup, eklavya-tutor and eklavya-explainer never count',
  foregroundBuilder: 'an implementation agent ran in the foreground (run_in_background not true)',
  builderWithinNudge: `the first background builder started fewer than ${WITHIN} parent tool calls after the nudge`,
  builderBeforeNudge: 'the first background builder started before the nudge fired',
  parentWritesBeforeBuilder: 'parent write calls (same heuristic) before the first background builder: substantial inline work before delegating',
  briefNamesWorktree: "every background builder's prompt contains the worktree's absolute path",
  briefNamesChecks: "every background builder's prompt names both `npm run lint` and `npm test`",
  stageAtATime: 'staged scenarios with a background builder: more than one builder, and a parent `git commit` between each launch and the next (one stage per builder, committed before the next)',
  askedWhileBuilding: 'trials with an AskUserQuestion in the parent between a background builder starting and its completion notification',
  recordedWhileBuilding: 'of those, a record_attempt followed the question before the next question',
  verdictWhileBuilding: 'and the parent text after record_attempt states right or wrong (word heuristic)',
  stageCommitsInOrder: 'staged scenarios: the task branch has commits tagged [stage 1] to [stage 4], in that order',
  stageChecksPass: 'staged scenarios: `npm run lint` and `npm test` pass at every commit on the task branch, checked by the harness',
  parentCommitted: 'a `git commit` was run by the parent conversation (not only by a subagent)',
  mainCheckoutTouched: 'the main checkout has uncommitted changes at the end: work landed in the wrong tree',
  fallbackVisible: 'nobg scenario: parent text says agents/background are unavailable and that it is working inline (word heuristic)',
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [command] = positionals();
if (command === 'run') await runCommand();
else if (command === 'score') scoreCommand();
else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) fail('usage: delegation-harness.mjs run --plugin <dir> [--label x] [--trials 3] [--scenarios a,b] [--parallel 3] | score <run-dir>');
