import { z } from 'zod';
import { loadConfig, isDomainEnabled } from '../config.js';
import { clampToLevel, decayedScore, isKnown, isDue, nextTierToAsk, suggestedTier } from '../srs.js';
import { levelStanding } from '../store.js';
import { CWD_HINT, type ToolDef } from './types.js';

const LIST_CAP = 8;
/** Mastered concepts are the "don't ask this" list, so it gets more room than the rest. */
const KNOWN_CAP = 30;
const WEAK_THRESHOLD = 0.5;

interface Row {
  id: number;
  slug: string;
  domain: string;
  tier: number;
  score: number | null;
  reps: number | null;
  next_review: string | null;
  attempts: number;
  last_grade: number | null;
  last_difficulty: number | null;
}

interface ProjectRow {
  /** `null` is the pre-migration-003 bucket, kept rather than dropped: hiding
   *  those rows would silently shrink every total the report prints. */
  repo: string | null;
  answers: number;
  passed: number;
  last_active: string;
}

interface RecentRow {
  slug: string;
  context: string;
  repo: string | null;
  ts: string;
}

interface SkippedRow {
  slug: string;
  outcome: string;
  repo: string | null;
  ts: string;
}

export const getLearnerProfile: ToolDef = {
  name: 'get_learner_profile',
  title: 'Get learner profile',
  description:
    'What this developer already knows. Call before teaching or quizzing so you never ask about a mastered concept. Returns mode, per-domain counts, the concepts already mastered, weak concepts, what is due for review, the tier to pitch at, and this project\'s difficulty level with the progress toward the next one. Every tier here is already clamped to that level. Also returns the three things a progress report needs and mastery counts cannot give: `projects` (per-repo answered/passed, so a report can say *which* codebase), `recent_concepts` (what was logged, with the context line naming the real code it came from) and `skipped` (declined or blanked, the actionable backlog).',
  inputSchema: {
    domain: z.string().optional().describe('Restrict to one domain, e.g. "web-auth".'),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { domain?: string; cwd?: string }, { db }) => {
    const now = new Date();
    const { config, repoRoot } = loadConfig(args.cwd);
    // Tiers reported here are what the tutor calibrates against, so they are
    // clamped to the project's band exactly as the planner clamps them. An
    // unclamped `suggested_tier` is how a learner on `easy` gets pitched at 3.
    const standing = levelStanding(db, config, repoRoot);

    const rows = db
      .prepare(
        `SELECT c.id, c.slug, c.domain, c.tier,
                m.score, m.reps, m.next_review,
                (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id) AS attempts,
                (SELECT a.grade FROM attempts a WHERE a.concept_id = c.id ORDER BY a.id DESC LIMIT 1) AS last_grade,
                (SELECT a.difficulty FROM attempts a WHERE a.concept_id = c.id ORDER BY a.id DESC LIMIT 1) AS last_difficulty
         FROM concepts c
         LEFT JOIN mastery m ON m.concept_id = c.id
         ${args.domain ? 'WHERE c.domain = ?' : ''}`,
      )
      .all(...(args.domain ? [args.domain] : [])) as Row[];

    const domains = new Map<string, { domain: string; known: number; learning: number; unseen: number }>();
    const knownTiers: number[] = [];
    const weak: { slug: string; score: number; tier: number }[] = [];
    const known: { slug: string; score: number }[] = [];
    const due: { slug: string; tier: number; tier_to_ask: number }[] = [];

    for (const row of rows) {
      if (!isDomainEnabled(config, row.domain)) continue;

      const bucket =
        domains.get(row.domain) ?? { domain: row.domain, known: 0, learning: 0, unseen: 0 };
      domains.set(row.domain, bucket);

      if (row.attempts === 0) {
        bucket.unseen += 1;
        continue;
      }

      // Decay is a read-time view only — never written back (PRD §7).
      const score = decayedScore(row.score ?? 0, row.next_review, now);
      const reps = row.reps ?? 0;

      if (isKnown({ score, reps })) {
        bucket.known += 1;
        knownTiers.push(row.tier);
        // Named, not just counted: the tutor is told never to re-ask a mastered
        // concept, which it can only honor if it is told which ones those are.
        known.push({ slug: row.slug, score });
      } else {
        bucket.learning += 1;
      }

      if (score < WEAK_THRESHOLD) weak.push({ slug: row.slug, score: Number(score.toFixed(2)), tier: row.tier });

      if (isDue(row.next_review, now)) {
        due.push({
          slug: row.slug,
          tier: row.tier,
          tier_to_ask: clampToLevel(
            nextTierToAsk({
              conceptTier: row.tier,
              lastDifficulty: row.last_difficulty,
              lastGrade: row.last_grade,
              score,
            }),
            standing.level,
          ),
        });
      }
    }

    const domainFilter = args.domain ? 'AND c.domain = ?' : '';
    const domainArg = args.domain ? [args.domain] : [];

    // Three things mastery counts cannot answer, and a progress report must:
    // which project this happened on, what was actually learned there, and
    // what was ducked. All three are already in the schema; nothing read them.
    const projects = db
      .prepare(
        `SELECT NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, count(*) AS answers,
                sum(CASE WHEN a.grade >= 3 THEN 1 ELSE 0 END) AS passed,
                max(a.ts) AS last_active
         FROM attempts a JOIN concepts c ON c.id = a.concept_id
         WHERE 1 = 1 ${domainFilter}
         GROUP BY repo
         ORDER BY last_active DESC
         LIMIT ?`,
      )
      .all(...domainArg, LIST_CAP) as ProjectRow[];

    // `session_concepts` has no repo of its own; the session's gate row carries
    // it. LEFT JOIN because a session that never opened a gate still logged work.
    const recent = db
      .prepare(
        `SELECT c.slug AS slug, sc.context AS context, sc.ts AS ts, g.repo AS repo
         FROM session_concepts sc
         JOIN concepts c ON c.id = sc.concept_id
         LEFT JOIN gates g ON g.session_id = sc.session_id
         WHERE sc.context IS NOT NULL AND trim(sc.context) <> '' ${domainFilter}
         ORDER BY sc.ts DESC
         LIMIT ?`,
      )
      .all(...domainArg, LIST_CAP) as RecentRow[];

    // A NULL outcome is a row written before migration 004, not a skip. `IN`
    // excludes it: counting those as ducked would invent a backlog.
    const skipped = db
      .prepare(
        `SELECT c.slug AS slug, a.outcome AS outcome, a.repo AS repo, a.ts AS ts
         FROM attempts a JOIN concepts c ON c.id = a.concept_id
         WHERE a.outcome IN ('declined','dont_know') ${domainFilter}
         ORDER BY a.ts DESC
         LIMIT ?`,
      )
      .all(...domainArg, LIST_CAP) as SkippedRow[];

    weak.sort((a, b) => a.score - b.score);
    due.sort((a, b) => b.tier - a.tier);
    known.sort((a, b) => b.score - a.score);

    return {
      mode: config.mode,
      domains: [...domains.values()].sort((a, b) => a.domain.localeCompare(b.domain)),
      known: known.slice(0, KNOWN_CAP).map((k) => k.slug),
      known_total: known.length,
      weak: weak.slice(0, LIST_CAP).map((w) => w.slug),
      due_for_review: due.slice(0, LIST_CAP),
      projects,
      recent_concepts: recent,
      skipped,
      suggested_tier: clampToLevel(suggestedTier(knownTiers), standing.level),
      level: {
        level: standing.level,
        next: standing.next,
        passed: standing.counts.passed,
        needed: standing.needed.answers,
        concepts: standing.counts.concepts,
        needed_concepts: standing.needed.concepts,
        accuracy: standing.accuracy,
        min_accuracy: standing.needed.accuracy,
        repo: standing.repo,
        ...(standing.pinned ? { pinned: true } : {}),
      },
      truncated: weak.length > LIST_CAP || due.length > LIST_CAP || known.length > KNOWN_CAP,
    };
  },
};
