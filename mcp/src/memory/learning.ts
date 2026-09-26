import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { isDomainEnabled } from '../config.js';
import { allConceptSlugs, insertConcept, logSessionConcept, newConceptsThisSession } from '../store.js';
import { findFuzzyMatch, isValidSlug, normalizeSlug } from '../slug.js';
import {
  addCandidate,
  entryById,
  resolveCandidate,
  timeline,
  type CandidateRow,
  type EntryRow,
} from './store.js';

/**
 * The bridge from evidence to the concept graph (PRD LRN-02).
 *
 * The rule this file exists to hold: **an observation is not an assessment**.
 * Nothing here records an attempt, moves a mastery score, clears review debt,
 * promotes a level or opens a gate. It only proposes what a session was *about*,
 * so the tutor has something to ask when the agent forgot to say.
 *
 * Explicit logging stays the fast path. This fills omissions — a session where
 * the model worked for an hour and called `log_session_concepts` not once — and
 * deliberately does not compete with a session that logged properly, because
 * an extractive guess is worse than the model's own account of its work.
 */

/** Words that are about the tooling rather than about anything worth learning. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'were', 'was', 'are', 'but',
  'add', 'added', 'fix', 'fixed', 'use', 'used', 'make', 'made', 'run', 'ran', 'file', 'files',
  'test', 'tests', 'code', 'line', 'lines', 'change', 'changed', 'update', 'updated', 'edit',
  'edited', 'touched', 'failed', 'asked', 'then', 'session', 'work', 'project',
]);

function phrasesFrom(entry: EntryRow): string[] {
  const text = [entry.title, entry.narrative, entry.facts ?? ''].join(' ');
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  // Bigrams as well as single words: `token` and `rotation` are each too vague
  // to name a concept, and `token-rotation` is exactly one.
  const phrases = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    phrases.add(words[i]!);
    if (i + 1 < words.length) phrases.add(`${words[i]}-${words[i + 1]}`);
  }
  return [...phrases];
}

/**
 * Proposes candidates for one entry by matching its language against concepts
 * the graph already knows.
 *
 * Matching an existing concept only. Minting a new one from an extractive
 * guess is how a graph fills with `edited-auth` and `failed-command`; the
 * provider observer proposes new slugs, and even those arrive as candidates.
 */
export function proposeFor(db: DB, entry: EntryRow, config: EklavyaConfig): number {
  const known = allConceptSlugs(db);
  if (!known.length) return 0;

  const seen = new Set<number>();
  let added = 0;
  for (const phrase of phrasesFrom(entry)) {
    const slug = normalizeSlug(phrase);
    if (!slug) continue;
    const match = known.find((k) => k.slug === slug) ?? findFuzzyMatch(slug, known);
    if (!match || seen.has(match.id)) continue;
    if (!isDomainEnabled(config, match.domain)) continue;
    seen.add(match.id);

    // A bigram that matched a whole slug is far stronger evidence than a single
    // word that fuzzy-matched, and the confidence has to say so or the ordering
    // in `pendingCandidates` is meaningless.
    const exact = match.slug === slug;
    addCandidate(db, {
      entryId: entry.id,
      slug: match.slug,
      name: match.slug,
      domain: match.domain,
      confidence: exact ? 0.7 : 0.4,
      project: entry.project,
    });
    added++;
  }
  return added;
}

/** Proposes for every entry of a project that has not been mined yet. */
export function proposeForProject(
  db: DB,
  config: EklavyaConfig,
  project: string,
  limit = 10,
  sessionId?: string,
): number {
  // Observations only. A session summary is a roll-up of observation titles
  // this has already mined, so including it proposes the same slugs a second
  // time -- harmless in itself, but it crowds the top five that `fillOmissions`
  // accepts for a session that logged nothing.
  const entries = timeline(db, { project, kind: 'observation', limit, ...(sessionId ? { sessionId } : {}) }).filter((entry) => {
    const row = db
      .prepare('SELECT 1 AS hit FROM learning_sources WHERE entry_id = ? LIMIT 1')
      .get(entry.id) as { hit: number } | undefined;
    return !row;
  });
  let added = 0;
  for (const entry of entries) added += proposeFor(db, entry, config);
  return added;
}

export interface FillResult {
  accepted: number;
  skipped: number;
  reason?: 'already_logged' | 'no_candidates' | 'budget';
}

/**
 * Logs evidence-derived concepts for a session that logged none of its own.
 *
 * The guard is the whole design. A session that logged properly is left alone:
 * the model's own account of what it wrote beats anything derived from tool
 * arguments, and adding to it would inflate the gate's `required` with guesses.
 * A session that logged nothing had no candidates at all, and one plausible
 * question about real work beats silence.
 *
 * That same check is also what keeps late evidence from reopening a passed gate
 * or re-arming a finished task (PRD LRN-04), and it is why no separate guard for
 * it exists here. It counts the whole of `session_concepts`, and the only other
 * writers are `log_session_concepts` — the one call that raises a gate's
 * `required` — and `record_attempt`, which writes a row before it grades. A
 * session with a gate worth reopening, or a quiz worth not repeating, therefore
 * always has rows, and this returns before its first write. Narrow that count to
 * one origin or one timestamp and the hazard becomes real.
 */
export function fillOmissions(
  db: DB,
  config: EklavyaConfig,
  sessionId: string,
  project: string,
): FillResult {
  const logged = db
    .prepare('SELECT COUNT(*) AS n FROM session_concepts WHERE session_id = ?')
    .get(sessionId) as { n: number };
  if (logged.n > 0) return { accepted: 0, skipped: 0, reason: 'already_logged' };

  // This session's own entries and nothing else. Mined project-wide, the
  // latest observations belong to whichever session wrote them, and a session
  // that looked empty was quizzed on another one's work: one "design system
  // compliance audit" entry turned up as `design-tokens` in four unrelated OIP
  // sessions in a day. Nothing of its own yet means nothing to ask, which is
  // the status quo, not a failure.
  proposeForProject(db, config, project, 10, sessionId);
  const candidates = sessionCandidates(db, project, sessionId, 20);
  if (!candidates.length) return { accepted: 0, skipped: 0, reason: 'no_candidates' };

  // The same budget an explicit log is held to. It is a cap on slug sprawl, and
  // a guess has less right to spend it than the model's own account does.
  const budget = Math.max(0, config.max_new_concepts_per_session - newConceptsThisSession(db, sessionId));
  if (budget === 0) return { accepted: 0, skipped: candidates.length, reason: 'budget' };

  let accepted = 0;
  let left = budget;
  // Two proposals can land on one concept (`table_layout` and `table-layout`);
  // count it once, or `accepted` stops matching the rows written.
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (accepted >= 5) break;
    const found = conceptFor(db, config, candidate, left > 0);
    if (found === 'no_budget') continue;
    if (!found) {
      resolveCandidate(db, candidate.id, 'rejected');
      continue;
    }
    const { concept, created } = found;
    if (created) left--;
    if (seen.has(concept.id)) {
      resolveCandidate(db, candidate.id, 'accepted', concept.id);
      continue;
    }
    seen.add(concept.id);
    const entry = candidate.entry_id ? entryById(db, candidate.entry_id) : undefined;
    logSessionConcept(
      db,
      sessionId,
      concept.id,
      entry ? `from memory: ${entry.title}` : 'derived from this session\'s evidence',
      'work',
    );
    resolveCandidate(db, candidate.id, 'accepted', concept.id);
    accepted++;
  }
  return { accepted, skipped: candidates.length - accepted };
}

/**
 * Pending candidates mined from this session's own entries or events, strongest
 * first. Filtered in the query, not after a project-wide limit: other sessions'
 * candidates are never resolved here, so they accumulate, and a capped list
 * would sooner or later hold none of this session's.
 */
function sessionCandidates(db: DB, project: string, sessionId: string, limit: number): CandidateRow[] {
  return db
    .prepare(
      `SELECT ls.* FROM learning_sources ls
        WHERE ls.status = 'candidate' AND ls.project = ? AND ls.confidence >= 0.7
          AND (ls.entry_id IN (SELECT id FROM memory_entries WHERE session_id = ?)
               OR ls.event_id IN (SELECT id FROM evidence_events WHERE session_id = ?))
        ORDER BY ls.confidence DESC, ls.id
        LIMIT ?`,
    )
    .all(project, sessionId, sessionId, limit) as CandidateRow[];
}

/**
 * The concept a candidate names, resolved the way `log_session_concepts`
 * resolves a slug: normalized, then an exact or fuzzy match, then created.
 *
 * Exact-only matching made this fallback useless. The provider observer writes
 * free-form slugs (`badge_component`, `text_truncation`) that are never already
 * in the graph character for character, so every one was rejected and a session
 * that forgot to log was never asked anything.
 *
 * Creating is safe here because of who can reach it. Extractive candidates
 * (`proposeFor`) always carry an existing slug, so they match; only the
 * observer's own proposals are ever new, and `sessionCandidates` has already
 * dropped anything under 0.7 confidence. A new concept is bare, as one from
 * `log_session_concepts` is, and spends the same per-session budget.
 */
function conceptFor(
  db: DB,
  config: EklavyaConfig,
  candidate: CandidateRow,
  mayCreate: boolean,
): { concept: { id: number }; created: boolean } | 'no_budget' | undefined {
  const slug = normalizeSlug(candidate.slug);
  if (!isValidSlug(slug)) return undefined;
  const known = allConceptSlugs(db);
  const match = known.find((k) => k.slug === slug) ?? findFuzzyMatch(slug, known);
  if (match) return isDomainEnabled(config, match.domain) ? { concept: match, created: false } : undefined;

  const domain = normalizeSlug(candidate.domain) || 'general';
  if (!isDomainEnabled(config, domain)) return undefined;
  // Left as a candidate rather than rejected: the budget is this session's, and
  // the proposal may still be worth something to a later fill.
  if (!mayCreate) return 'no_budget';
  const concept = insertConcept(db, {
    slug,
    name: candidate.name?.trim() || slug.replace(/-/g, ' '),
    domain,
    tier: 2,
    source: 'llm',
  });
  return { concept, created: true };
}
