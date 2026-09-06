/**
 * SessionStart: stamp the session id and print a one-line learner profile.
 *
 * Hard rule (PRD §9.1): this must never break a session. Every failure path
 * exits 0 with no output — `run()` enforces it.
 */
import { setCurrentSession } from '../session.js';
import { levelStanding } from '../store.js';
import { run, openExisting, config, cwdOf, sessionId, type DB } from './lib.js';

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
 * "seen" is a mastery row, which only exists once a concept has been attempted.
 * Gated on that rather than on anything being mastered yet, or a learner three
 * attempts in is told they have no history.
 */
function domainSummary(db: DB): string {
  const rows = db
    .prepare(
      `SELECT c.domain AS domain,
              sum(CASE WHEN m.score >= 0.7 AND m.reps >= 2 THEN 1 ELSE 0 END) AS known,
              count(*) AS total,
              sum(CASE WHEN m.concept_id IS NOT NULL THEN 1 ELSE 0 END) AS seen
         FROM concepts c LEFT JOIN mastery m ON m.concept_id = c.id
        GROUP BY c.domain
       HAVING seen > 0
        ORDER BY known DESC, seen DESC
        LIMIT 3`,
    )
    .all() as Array<{ domain: string; known: number; total: number }>;

  return rows.map((r) => `${r.domain} ${r.known}/${r.total} known`).join(', ');
}

/**
 * Not "reps > 0": a failing grade resets reps to 0, so that filter would hide
 * precisely the concepts the learner is struggling with. A mastery row at all
 * means it has been attempted.
 */
function weakest(db: DB): string {
  const rows = db
    .prepare(
      `SELECT c.slug AS slug FROM concepts c
         JOIN mastery m ON m.concept_id = c.id
        WHERE m.score < 0.5
        ORDER BY m.score ASC
        LIMIT 3`,
    )
    .all() as Array<{ slug: string }>;

  return rows.map((r) => r.slug).join(', ');
}

function dueCount(db: DB): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM mastery
        WHERE next_review IS NOT NULL
          AND next_review <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

await run(async (input) => {
  const db = openExisting();
  if (!db) return 0;

  const cwd = cwdOf(input);
  const sid = sessionId(input, db);

  // Stamp the session so MCP tools resolve the same id the hooks will use later
  // (decision G1). This happens even when the banner is suppressed.
  if (sid) setCurrentSession(db, sid);

  const resolved = config(cwd);
  const { mode, focus, focus_topic, cadence, difficulty, quiet } = resolved.config;
  if (mode === 'off') return 0;

  const focusLabel = focus === 'learn' && focus_topic ? `learn (${focus_topic})` : focus;

  // The level, and how far into it they are. This is the one number that makes
  // the runway visible: without it, week one and week ten look identical from
  // the outside, and a learner on `easy` reads tier-2 questions as Eklavya being
  // shallow rather than as a band they are working through.
  //
  // `levelStanding` is the server's own function, so the banner cannot drift
  // from what the quiz planner actually does — the shell version reimplemented
  // this query and had to keep it in step by hand.
  let levelLabel = `${difficulty} (pinned)`;
  if (difficulty === 'auto') {
    const standing = levelStanding(db, resolved.config, resolved.repoRoot);
    levelLabel = `${standing.level} (${standing.counts.passed}/${standing.needed.answers} on this project)`;
  }

  if (quiet) return 0;

  const domains = domainSummary(db);
  const out: string[] = [];

  if (!domains) {
    // Nothing learned yet — say the useful thing instead of an empty scoreboard.
    out.push(
      `[Eklavya] No learning history yet. Mode: ${mode}. Focus: ${focusLabel}. Cadence: ${cadence}. Level: ${levelLabel}.`,
    );
  } else {
    let line = `[Eklavya] Learner profile: ${domains}.`;
    const weak = weakest(db);
    if (weak) line += ` Weak: ${weak}.`;
    const due = dueCount(db);
    if (due > 0) line += ` ${due} concept(s) due for review.`;
    out.push(
      `${line} Mode: ${mode}. Focus: ${focusLabel}. Cadence: ${cadence}. Level: ${levelLabel}.`,
    );
  }

  if (resolved.overrides.length > 0) {
    out.push(
      `[Eklavya] This repo overrides your global setting for: ${resolved.overrides.join(' ')} (.eklavya.json wins).`,
    );
  }

  out.push(DIRECTIVE);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
});
