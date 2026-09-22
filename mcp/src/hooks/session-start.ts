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
import { run, openExisting, config, cwdOf, sessionId, clearNudgeState, type DB } from './lib.js';
import { flushAtSeam, identityOf, recallBlock, record, replaySpool } from './memory-lib.js';
import { startupDisplay } from '../memory/recall.js';

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

await run(async (input) => {
  const cwd = cwdOf(input);

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

  const db = openExisting();
  if (!db) return 0;

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
  const dormant: string[] = [];
  const memoryEnabled = resolved.config.memory.enabled;
  if (memoryEnabled) {
    replaySpool(db);
    // Drain first, then mark the seam. The other order batches the lifecycle
    // event on its own and summarises "session started" into an observation of
    // nothing.
    await flushAtSeam(db, resolved, identity);
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
    if (!quiet) {
      dormant.push(
        memoryEnabled
          ? '[Eklavya] Questions are off for this project (`quiz.enabled: false`). Memory is still recording and recalling — `memory.enabled: false` is the dial for that.'
          : '[Eklavya] Questions and memory are both off for this project. Nothing is being recorded.',
      );
    }
    dormant.push(...memoryContext);
    if (dormant.length) process.stdout.write(`${dormant.join('\n')}\n`);
    return 0;
  }
  // Fires on resume and after a compaction too, with the same session id, so a
  // session silenced an hour ago stays silent rather than greeting its way back.
  if (isSessionOff(db, sid)) return 0;

  const out: string[] = [];

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
    banner(db, out, {
      project: identity.project,
      memory: resolved.config.memory.enabled,
      levelLabel,
      overrides: resolved.overrides,
    });
  }

  // Said even when `quiet` is set, and said before the directive, because it is
  // not a greeting: a lead who pinned `quiz.enforced` has been promised commits
  // are held, and in Cowork nothing holds them. The gate matches `git commit` in
  // a Bash call, and Cowork sessions do not commit. Better to say so once per
  // session than to let someone believe an unenforceable setting is enforcing.
  if (quiz.enforced && isCowork()) {
    out.push(
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
  out.push(...memoryContext);
  out.push(withSurfaceNote(DIRECTIVE));
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
});

interface BannerParts {
  project: string;
  memory: boolean;
  levelLabel: string;
  overrides: string[];
}

/**
 * The developer-facing greeting, and everything `quiet` is about.
 *
 * Three lines (PRD UX-01): a heading, what reuse saved, and where this project
 * stands. Deliberately short. It used to print the learner profile, the weakest
 * concepts, the due count and every dial — a scoreboard at the moment
 * somebody sat down to work, none of which they had asked for. The dials live
 * in the status bar (`eklavya statusline`), the profile and the weak list live
 * in the dashboard, and both are there when they are wanted.
 *
 * Every number here is already committed to the database. Nothing waits on a
 * provider call or an index rebuild to greet somebody.
 */
function banner(db: DB, out: string[], parts: BannerParts): void {
  const display = startupDisplay(db, parts.project);
  const [heading, savings, counts] = display.lines as [string, string, string];
  out.push(heading);
  // With memory off there is no reuse to report, and a line saying so every
  // morning is noise about a feature the developer turned off on purpose.
  if (parts.memory) out.push(savings);
  // The runway rides on the counts line rather than taking one of its own: it
  // is the same subject -- where this project stands -- and UX-01's budget is
  // three lines, not three subjects spread over five.
  out.push(`${counts} · Level ${parts.levelLabel}`);

  if (parts.overrides.length > 0) {
    // A warning, not a scoreboard: a repo silently overriding a personal
    // setting is the one thing worth interrupting for.
    out.push(
      `Your settings for this project override your global ones for: ${parts.overrides.join(' ')}.`,
    );
  }
}
