import path from 'node:path';
import type { EntryRow, EvidenceRow } from './store.js';

/**
 * The `Summarizer` port and its local implementation (ADR-04).
 *
 * Two implementations from the start, because the choice between them is a
 * privacy decision rather than a quality tuning knob: the local one never leaves
 * the machine, the provider one sends the batch to an API the developer
 * configured and was told about. Nothing here decides which is used — `worker.ts`
 * reads the configuration and composes.
 */

export interface EntryDraft {
  title: string;
  type: string | null;
  narrative: string;
  facts: string[];
  files: string[];
  tags: string[];
  confidence: number;
  eventIds: number[];
  /**
   * Concepts the summariser believes the work touched. Proposals only: they
   * become `learning_sources` rows with `status = 'candidate'`, and the
   * existing validation and new-concept budget decide what reaches the graph.
   */
  concepts?: { slug: string; name: string; domain: string }[];
}

export interface SummarizeInput {
  project: string;
  sessionId: string;
  events: EvidenceRow[];
}

export interface Summarizer {
  readonly id: string;
  summarize(input: SummarizeInput): Promise<EntryDraft[]>;
}

function jsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    // A malformed files column is a bug elsewhere; here it is simply no files.
    return [];
  }
}

function filesOf(rows: { files: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const f of jsonList(row.files)) seen.add(f);
  return [...seen];
}

/**
 * Tags from the paths the work touched.
 *
 * Path segments are a genuinely good signal for "what area was this" — `src/auth`
 * and `migrations` say more about a batch than any keyword in its prose — and
 * they cost nothing. Extensions add the language.
 */
function tagsFor(files: string[], events: EvidenceRow[]): string[] {
  const tags = new Set<string>();
  for (const file of files) {
    const ext = path.extname(file).replace('.', '').toLowerCase();
    if (ext && ext.length <= 5) tags.add(ext);
    for (const segment of path.dirname(file).split(/[\\/]/)) {
      const clean = segment.toLowerCase();
      if (clean && clean !== '.' && clean !== 'src' && clean.length > 2 && !clean.startsWith('.')) {
        tags.add(clean);
      }
    }
  }
  if (events.some((e) => e.kind === 'tool_error')) tags.add('failure');
  return [...tags].slice(0, 12);
}

const TYPE_HINTS: [RegExp, string][] = [
  [/\b(fix|bug|broken|regression|crash|failing)\b/i, 'bugfix'],
  [/\b(refactor|extract|rename|clean ?up|simplify)\b/i, 'refactor'],
  [/\b(decide|decision|chose|instead of|tradeoff|trade-off)\b/i, 'decision'],
  [/\b(add|implement|build|introduce|support)\b/i, 'feature'],
  [/\b(why|turns out|discovered|found that|because)\b/i, 'discovery'],
];

function typeFor(text: string, events: EvidenceRow[]): string {
  for (const [re, type] of TYPE_HINTS) if (re.test(text)) return type;
  return events.some((e) => e.kind === 'tool_error') ? 'bugfix' : 'change';
}

function firstLine(text: string, max = 90): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The default summariser: no network, no key, no waiting.
 *
 * It is extractive rather than generative — it quotes and counts what the
 * evidence already says instead of writing prose about it. That ceiling is
 * real: it cannot explain *why* a change was made unless the developer said so
 * in a prompt. It is also why it can run inside a hook without a budget.
 */
export class LocalSummarizer implements Summarizer {
  readonly id = 'local-v1';

  async summarize(input: SummarizeInput): Promise<EntryDraft[]> {
    const { events } = input;
    if (!events.length) return [];
    // A batch of nothing but session markers is a session in which nothing
    // happened. Recording "session started" as a memory is how a corpus fills
    // with rows that push real work out of a bounded recall.
    if (events.every((e) => e.kind === 'lifecycle')) return [];

    const prompts = events.filter((e) => e.kind === 'prompt');
    const errors = events.filter((e) => e.kind === 'tool_error');
    const edits = events.filter((e) => e.kind === 'file_edit');
    const files = filesOf(events);
    const intent = prompts[0]?.body ?? events.find((e) => e.title)?.title ?? '';

    const title = firstLine(intent) || (files[0] ? `Worked on ${files[0]}` : 'Session work');

    const lines: string[] = [];
    if (intent) lines.push(`Asked: ${firstLine(intent, 200)}`);
    if (edits.length) lines.push(`Edited ${edits.length} time(s) across ${files.length} file(s).`);
    if (errors.length) lines.push(`${errors.length} tool failure(s) during the work.`);
    for (const later of prompts.slice(1, 4)) lines.push(`Then asked: ${firstLine(later.body, 160)}`);

    const facts: string[] = [];
    for (const error of errors.slice(0, 3)) facts.push(`Failed: ${firstLine(error.body, 160)}`);
    for (const file of files.slice(0, 6)) facts.push(`Touched ${file}`);

    return [
      {
        title,
        type: typeFor(`${intent}\n${events.map((e) => e.title ?? '').join('\n')}`, events),
        narrative: lines.join('\n'),
        facts,
        files,
        tags: tagsFor(files, events),
        // Extractive, so the claims are as reliable as their sources — but it
        // did not understand anything, and a confidence of 1 would say it did.
        confidence: 0.5,
        eventIds: events.map((e) => e.id),
      },
    ];
  }
}

/** How many observations a summary will name before it stops listing them. */
const SUMMARY_MAX_LINES = 12;

/**
 * The session summary (PRD MEM-01, PAR-03).
 *
 * An observation answers "what happened in this batch". A session summary
 * answers the only question the *next* session opens with — where did I leave
 * off — and it exists because recall hands back the top of the timeline. Without
 * one, a developer resuming on Monday is handed whichever ten tool calls
 * happened to end Friday, rather than what Friday was about. Until now only the
 * Claude Mem importer ever wrote `kind = 'session_summary'`, so an imported
 * history had them and a natively captured one never did.
 *
 * It rolls up the session's own observations rather than re-reading the raw
 * evidence. The evidence has already been read once: a second pass would mean a
 * second provider request per session, which is exactly the wait LRN-04 keeps
 * out of a seam, and evidence the summariser already judged not worth keeping
 * should not come back in through a different door.
 *
 * Returns null when there is nothing to say, because an entry is forever and a
 * summary of nothing is noise in every future recall. Two observations is the
 * floor, deliberately: with one, the summary is that observation retyped, and a
 * near-duplicate row competing with its own source for a bounded recall budget
 * costs more than it tells anyone.
 */
export function summarizeSession(observations: EntryRow[]): EntryDraft | null {
  if (observations.length < 2) return null;
  const ordered = [...observations].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  const files = filesOf(ordered);
  const counts = new Map<string, number>();
  for (const o of ordered) counts.set(o.type ?? 'change', (counts.get(o.type ?? 'change') ?? 0) + 1);
  const commonest = [...counts].sort((a, b) => b[1] - a[1])[0]![0];

  const listed = ordered.slice(0, SUMMARY_MAX_LINES);
  const narrative = [
    `${ordered.length} observations across ${files.length} file(s) in this session.`,
    ...listed.map((o) => `- ${o.type ?? 'change'}: ${firstLine(o.title, 120)}`),
    ordered.length > listed.length ? `- …and ${ordered.length - listed.length} more.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    title: `Session: ${firstLine(ordered[0]!.title, 80)}`,
    type: commonest,
    narrative,
    facts: files.slice(0, 10).map((f) => `Touched ${f}`),
    files,
    // `session` first so the tag survives the cap on a session that touched a
    // deep tree, and so a summary is filterable as one.
    tags: ['session', ...tagsFor(files, [])].slice(0, 12),
    // No more reliable than the least reliable thing underneath it.
    confidence: Math.min(...ordered.map((o) => o.confidence ?? 0.5)),
    // Deliberately no event links. `pruneEvidence` keeps any event an entry
    // still points at, so a summary citing a whole session would pin that
    // session's raw evidence past `memory.retention_days` for ever — the one
    // promise SEC-02 makes about raw capture. The price is a receipt that
    // scores this row as pure overhead; the other trade is worse.
    eventIds: [],
  };
}
