/**
 * Retrieval scoring: pure arithmetic over a ranked list and a labelled set.
 *
 * Lives here, beside the other eval scorers, for the same reason they do: no
 * model, no I/O, so it is unit-testable and the harness has nothing to get
 * subtly wrong. `eval/retrieval-harness.mjs` supplies the rankings.
 *
 * The metric set is small, standard, and read in a particular order.
 *
 * **Top-1** is the headline. On a corpus where most queries have one right
 * answer, precision@5 is arithmetic about how many results a mode returned
 * rather than about whether they were good: a mode that always fills the slate
 * scores 0.2 however perfect its ranking. Top-1 asks the question the developer
 * asks — was the first thing it showed me the right thing.
 *
 * **Recall@k** is the one a savings percentage cannot see. Omitting useful
 * evidence looks like an excellent saving (PRD MET-01), so it is reported
 * beside precision and never blended into it.
 *
 * **Precision@k** still earns its place at a tight budget, where returning four
 * irrelevant entries costs four entries' worth of the token budget.
 */

export interface RankedResult {
  /** Query identifier, matching a label set. */
  query: string;
  /** Entry ids in rank order, best first. */
  ranked: number[];
}

export interface QueryScore {
  query: string;
  relevant: number;
  retrieved: number;
  hits: number;
  precision: number;
  recall: number;
  /** Reciprocal rank of the first relevant hit, 0 when there is none. */
  rr: number;
  /** 1 when the top-ranked result was relevant. The headline metric. */
  top1: number;
}

export function scoreQuery(ranked: number[], relevant: number[], k: number): QueryScore & { query: string } {
  const top = ranked.slice(0, k);
  const wanted = new Set(relevant);
  const hits = top.filter((id) => wanted.has(id)).length;
  const firstHit = top.findIndex((id) => wanted.has(id));
  return {
    query: '',
    relevant: relevant.length,
    retrieved: top.length,
    hits,
    precision: top.length ? hits / top.length : 0,
    recall: relevant.length ? hits / relevant.length : 0,
    rr: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    top1: firstHit === 0 ? 1 : 0,
  };
}

export interface RetrievalSummary {
  queries: number;
  k: number;
  top1: number;
  precision: number;
  recall: number;
  mrr: number;
  /** Queries that returned nothing relevant at all. */
  misses: string[];
}

export function summarise(scores: QueryScore[], k: number): RetrievalSummary {
  const n = scores.length || 1;
  return {
    queries: scores.length,
    k,
    top1: round(scores.reduce((s, q) => s + q.top1, 0) / n),
    precision: round(scores.reduce((s, q) => s + q.precision, 0) / n),
    recall: round(scores.reduce((s, q) => s + q.recall, 0) / n),
    mrr: round(scores.reduce((s, q) => s + q.rr, 0) / n),
    misses: scores.filter((q) => q.hits === 0).map((q) => q.query),
  };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Compares two modes on the same labels.
 *
 * The comparison is the point of the whole eval: "hybrid is better" is a claim
 * about two numbers on one corpus, and it belongs in the manual only once this
 * has produced them. A mode that wins on precision and loses on recall has not
 * won, which is why both are reported rather than one blended score.
 */
export function compare(
  a: { mode: string; summary: RetrievalSummary },
  b: { mode: string; summary: RetrievalSummary },
): { better: string | null; top1Delta: number; recallDelta: number } {
  // Top-1 and recall, not precision@k: see the note at the top of the file for
  // why precision@k on a one-answer corpus measures slate size, not quality.
  const top1Delta = round(b.summary.top1 - a.summary.top1);
  const recallDelta = round(b.summary.recall - a.summary.recall);
  if (top1Delta > 0 && recallDelta >= 0) return { better: b.mode, top1Delta, recallDelta };
  if (top1Delta < 0 && recallDelta <= 0) return { better: a.mode, top1Delta, recallDelta };
  if (top1Delta === 0 && recallDelta > 0) return { better: b.mode, top1Delta, recallDelta };
  if (top1Delta === 0 && recallDelta < 0) return { better: a.mode, top1Delta, recallDelta };
  return { better: null, top1Delta, recallDelta };
}
