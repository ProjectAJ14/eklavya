import path from 'node:path';
import type { EvidenceRow } from './store.js';

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

function filesOf(events: EvidenceRow[]): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.files) continue;
    try {
      for (const f of JSON.parse(e.files) as string[]) seen.add(f);
    } catch {
      // A malformed files column is a bug elsewhere; here it is simply no files.
    }
  }
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
