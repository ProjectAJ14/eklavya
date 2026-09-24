/**
 * SessionStart: stamp the session id and print a one-line learner profile.
 *
 * Hard rule: this must never break a session. Every failure path
 * exits 0 with no output — `run()` enforces it.
 */
import { findRepoConfig, mainRepoRoot, migrateLegacyRepoConfig } from '../config.js';
import { isSessionOff, setCurrentSession } from '../session.js';
import { levelStanding } from '../store.js';
import { isCowork, withSurfaceNote } from '../surface.js';
import { run, openOrDiagnose, config, cwdOf, sessionId, clearNudgeState, type DB, type DbProblem } from './lib.js';
import { flushAtSeam, identityOf, recallBlock, record, replaySpool } from './memory-lib.js';
import { startupDisplay } from '../memory/recall.js';
import { savingsLine } from '../memory/tokens.js';
import { dialParts, paint } from '../statusline.js';
import { DEFAULT_PORT } from '../paths.js';
import { markAnnounced, startBackgroundUpdate, updateNotice } from '../update.js';
import net from 'node:net';

/**
 * The whole tutoring loop starts at log_session_concepts: it is the only writer
 * of session_concepts, and the Stop hook quizzes from nothing else. An unlogged
 * session is a silent no-op no matter how much was taught in it, and the Stop
 * hook exits 0 without a word, so the failure looks like "Eklavya is broken".
 *
 * The tutor skill already says to log, but it is model-invoked — it competes
 * with every other skill on the machine and may never load. So the instruction
 * is stated here, where every session sees it before any skill is chosen.
 */
const DIRECTIVE = `[Eklavya] Standing instruction for this session, on every task — not only when asked to teach:
  - Once you know what a task involves, call log_session_concepts with the 3-8 concepts it
    genuinely exercises. Omit session_id. Log while implementing, not at the end.
  - Log what the code is *about* (jwt-verification, react-effect-cleanup, sql-index-selectivity),
    not what you did. Give each one a context line naming the real code you wrote.
  - Guessed slugs are fine: unknown ones are fuzzy-matched or created.
  - Skip this and there is nothing to quiz on, so nothing is ever learned. Load the tutor skill
    for how to ask and grade.
  - Logging may come straight back with an [Eklavya checkpoint]: ONE multiple-choice question to
    ask right then, before the next line of code, then back to the task in the same turn. That
    interruption is the product -- learning while the work happens, not a pile of questions after
    it. One question, no summary, no re-plan, no second question.`;

/**
 * The auto-updater's one line, if it has one: "updated to X" once, or "can't
 * update itself" every session until it clears. Shown whatever `quiet` says,
 * like the database health line -- it is a status, not a greeting. Read before
 * the run below starts, so it reports the last finished run, never this one.
 */
let updateLine: ReturnType<typeof updateNotice> = null;

await run(async (input) => {
  const cwd = cwdOf(input);

  // First, and before any early return: an install that cannot open its
  // database is exactly the one a newer release might fix. Both calls swallow
  // their failures; the run itself is a detached process nobody waits on.
  try {
    updateLine = updateNotice();
  } catch {
    /* no line is fine */
  }
  startBackgroundUpdate();

  // Lift a leftover `<repo>/.eklavya.json` out of the checkout, silently. This
  // is the moment that makes the move automatic: settings files stopped living
  // in repositories, and nobody should have to be told so or do anything about
  // it. `loadConfig` reads the legacy file until this lands, so the session it
  // runs in is configured identically either way. It never throws.
  //
  // **Before the database check below**, and that ordering is the whole point:
  // this has nothing to do with the database, and behind that guard it never ran
  // on a fresh install -- the one case where the file is most likely to be a
  // just-cloned repo's, and where the next thing to happen is `openDb` creating
  // the database and every later session finding the move already done.
  const { repoRoot } = findRepoConfig(cwd);
  if (repoRoot) migrateLegacyRepoConfig(repoRoot, mainRepoRoot(repoRoot));

  // No database yet is a first session: the server is creating it, and there
  // is nothing to say. One that is there and unusable is Eklavya stopped, and
  // the developer is told once, whatever `quiet` says -- it is not a greeting.
  const { db, problem } = openOrDiagnose();
  if (!db) return emit(problem ? [healthLine(problem)] : [], []);

  const sid = sessionId(input, db);

  // Stamp the session so MCP tools resolve the same id the hooks will use later
  // (decision G1). This happens even when the banner is suppressed.
  if (sid) setCurrentSession(db, sid, cwd);

  const resolved = config(cwd);
  const { quiz, difficulty, quiet } = resolved.config;

  // The memory half runs before every learning gate below, because it is not
  // governed by them (PRD CFG-01): `quiz.enabled: false` means no quizzes, not
  // no history. Three jobs, all silent on failure -- replay whatever the spool
  // holds, mark the seam, and drain any batch the last session left queued.
  const identity = identityOf(input, cwd, sid);
  const memoryContext: string[] = [];
  const memoryEnabled = resolved.config.memory.enabled;
  if (memoryEnabled) {
    replaySpool(db);
    // Drain first, then mark the seam. The other order batches the lifecycle
    // event on its own and summarises "session started" into an observation of
    // nothing. `all`: the last session has no seam of its own left, so its
    // tail is closed now however small — the Stop hook's size and age
    // thresholds are for a session that will have another turn. Not on
    // `compact`: that is the same session carrying on, and forcing its tail
    // shut on every compaction is a model call per compaction for nothing.
    // ponytail: `all` is project-wide, so a second live session in the same
    // repository also has its short tail closed at this start — one extra
    // small batch per session start; telling live from ended needs a signal
    // the hook does not have.
    await flushAtSeam(db, resolved, identity, { all: input.source !== 'compact' });
    record(db, resolved, identity, {
      kind: 'lifecycle',
      title: input.source === 'resume' ? 'session resumed' : 'session started',
      body: `source=${input.source ?? 'startup'} cwd=${cwd}`,
    });
    const block = recallBlock(db, resolved, identity, 'session_start');
    if (block) memoryContext.push(block);
  }

  if (!quiz.enabled) {
    // Recall still has a job here: the developer turned quizzing off, not
    // project memory. Nothing else this hook says applies.
    //
    // The line below it is the whole reason the `mode` dial was retired. With
    // quizzing off and nothing yet recalled -- a first session in a repo, which
    // is exactly when somebody is deciding whether this tool works -- this hook
    // used to print nothing whatsoever, and a plugin that greets you with
    // silence is a plugin you conclude is broken. It was not: memory was
    // recording the entire time, with no way to tell from the outside. One line
    // costs nothing and answers the question before it is asked.
    const shown: string[] = [];
    if (!quiet && memoryEnabled) {
      banner(db, shown, {
        project: identity.project,
        memory: true,
        dials: ['memory on', 'questions off'],
        overrides: resolved.overrides,
        dashboard: await dashboardLive(),
        quiz: false,
      });
    } else if (!quiet) {
      shown.push('Eklavya off · no questions, nothing recorded');
    }
    return emit(shown, memoryContext);
  }
  // Fires on resume and after a compaction too, with the same session id, so a
  // session silenced an hour ago stays silent rather than greeting its way back.
  if (isSessionOff(db, sid)) return 0;

  // Two audiences, two channels. `shown` is for the developer; `context` is for
  // the model. See `emit` for why they cannot share one.
  const shown: string[] = [];
  const context: string[] = [];

  // `quiet` suppresses the banner, and only the banner. It used to return here,
  // which also dropped the directive below -- so a developer who turned the
  // greeting off silently turned the whole product off: nothing was logged, so
  // the Stop hook found no candidates, so no question was ever asked, while
  // `get_config` went on reporting quizzing as enabled. The manual has always said
  // this key "suppresses the session-start banner and the statusline output",
  // and `quiz.enabled: false` is the documented way to stop the questions.
  if (!quiet) {
    // The runway, and the one place it is visible: without it week one and week
    // ten look identical from the outside, and a learner on `easy` reads a
    // tier-2 question as Eklavya being shallow rather than as a band they are
    // working through. `levelStanding` is the planner's own function, so the
    // greeting cannot drift from what the quiz actually does.
    let levelLabel = `${difficulty} (pinned)`;
    if (difficulty === 'auto') {
      const standing = levelStanding(db, resolved.config, resolved.repoRoot);
      levelLabel = `${standing.level} (${standing.counts.passed}/${standing.needed.answers})`;
    }
    banner(db, shown, {
      project: identity.project,
      memory: resolved.config.memory.enabled,
      dials: dialParts(resolved.config, levelLabel),
      overrides: resolved.overrides,
      dashboard: await dashboardLive(),
      quiz: true,
    });
  }

  // Said even when `quiet` is set, and said before the directive, because it is
  // not a greeting: a lead who pinned `quiz.enforced` has been promised commits
  // are held, and in Cowork nothing holds them. The gate matches `git commit` in
  // a Bash call, and Cowork sessions do not commit. Better to say so once per
  // session than to let someone believe an unenforceable setting is enforcing.
  if (quiz.enforced && isCowork()) {
    shown.push(
      '[Eklavya] Quizzing is enforced, but this is a Cowork session: the commit gate holds `git commit`, ' +
        'and there are no commits here. Questions still come and the gate still records — nothing is blocked.',
    );
  }

  // The directive is on screen again, so the nudge's clock starts again. This
  // hook fires on resume and after a compaction, not only at startup, and both
  // reuse the session id -- without this the first prompt of a resumed session
  // restates what was printed seconds ago.
  if (sid) clearNudgeState(db, sid);

  // Before the directive: it is what the session is *about*, and the directive
  // is what to do about it.
  context.push(...memoryContext);
  context.push(withSurfaceNote(DIRECTIVE));
  return emit(shown, context);
});

/**
 * One envelope, split by audience.
 *
 * This hook used to print everything as plain stdout, and on SessionStart plain
 * stdout is context: the model reads it and the developer never sees it. So the
 * banner -- three lines written for a person, and the "questions are off, memory
 * is still recording" line that exists precisely so a quiet install does not
 * look broken -- went to the one reader it was not for, and every session opened
 * in silence. `systemMessage` is the only field the harness renders to the
 * developer (top level, not inside `hookSpecificOutput`, where it is dropped);
 * `additionalContext` is the model's. Nothing is sent to both: the model has
 * `get_config` and `get_learner_profile` for anything the banner says.
 */
function emit(shown: string[], context: string[]): number {
  if (updateLine) {
    shown = [...shown, updateLine.text];
    if (updateLine.announces) markAnnounced(updateLine.announces);
  }
  if (!shown.length && !context.length) return 0;
  process.stdout.write(
    `${JSON.stringify({
      ...(shown.length > 0 && { systemMessage: shown.join('\n') }),
      ...(context.length > 0 && {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') },
      }),
    })}\n`,
  );
  return 0;
}

interface BannerParts {
  project: string;
  memory: boolean;
  dials: string[];
  overrides: string[];
  /** True when `eklavya dashboard` is already serving on its default port. */
  dashboard: boolean;
  /** False with `quiz.enabled: false`: no learning counts to report. */
  quiz: boolean;
}

/**
 * The developer-facing greeting, and everything `quiet` is about.
 *
 * Read in a glance, not studied: is it on, what are the dials, what did it
 * save me, where do I look for more. Four lines at most. It used to print the
 * learner profile, the weakest concepts and the due list -- a scoreboard at the
 * moment somebody sat down to work -- and those live in the dashboard.
 *
 * Every number here is already committed to the database. Nothing waits on a
 * provider call or an index rebuild to greet somebody.
 */
function banner(db: DB, out: string[], parts: BannerParts): void {
  // Inside the function, not at module scope: the hook body above runs at the
  // top-level `await`, before any later `const` is initialised.
  // NO_COLOR is the cross-tool convention; the host renders ANSI in systemMessage.
  const color = !process.env.NO_COLOR;
  const dim = (text: string) => (color ? `\u001b[2m${text}\u001b[0m` : text);
  const { savings, counts } = startupDisplay(db, parts.project);
  out.push(`Eklavya active · ${parts.dials.join(' · ')}`);
  // Only a real saving earns a line. "Nothing reused yet" every morning of a
  // first week is words about nothing; an overhead is rare and worth admitting.
  if (parts.memory && savings.kind === 'saving') {
    out.push(paint(`${savings.percent}% less context from memory reuse`, 114, color));
  } else if (parts.memory && savings.kind === 'overhead') {
    out.push(savingsLine(savings));
  }
  if (parts.quiz) out.push(`Learning ${counts.learning} · Mastered ${counts.mastered} · Due ${counts.due}`);

  if (parts.overrides.length > 0) {
    // A warning, not a scoreboard: a repo silently overriding a personal
    // setting is the one thing worth interrupting for.
    out.push(`Project settings override global: ${parts.overrides.join(' ')}`);
  }

  // A link only when something answers it; the dashboard runs on demand, and a
  // dead URL in the greeting is a small lie.
  const url = `http://127.0.0.1:${DEFAULT_PORT}`;
  out.push(
    dim(
      parts.dashboard
        ? `Dashboard ${url} · Observations ${url}/#/memory`
        : 'Dashboard & observations: eklavya dashboard',
    ),
  );
}

/** State and fix, one line: read in a glance, acted on without the manual. */
function healthLine(problem: DbProblem): string {
  return problem === 'native'
    ? "Eklavya paused · its SQLite module doesn't match this Node version · run: eklavya doctor"
    : "Eklavya paused · can't open its database · run: eklavya doctor";
}

/** A 150ms loopback probe: refused is instant, and a silent port is not waited on. */
function dashboardLive(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: DEFAULT_PORT });
    const done = (up: boolean) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(150, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
