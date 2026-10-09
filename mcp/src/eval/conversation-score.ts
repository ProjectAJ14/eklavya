/**
 * The deterministic half of the conversation eval.
 *
 * `question-checks.ts` scores one question. The rules that decide whether a
 * session goes well live elsewhere: what a blank earns, what a decline earns,
 * whether a checkpoint stays one question, whether a parallel tutor hands the
 * explainer everything it needs. A scenario freezes one moment (the plan, the
 * question asked, what the learner said) and the model replies with the tool
 * calls and message it would produce next; this module judges that reply
 * against rules written as data.
 *
 * Pure like `question-checks.ts`: no model, no files, no clock.
 */

/** What the model says it would do next. */
export interface TutorTurn {
  tool_calls: { tool: string; args?: Record<string, unknown> }[];
  /** What the learner would read. */
  message: string;
}

/** One rule a turn must satisfy. `id` is what the report names. */
export type Rule =
  | { id: string; kind: 'call'; tool: string; where?: Record<string, Match>; min?: number; max?: number }
  | { id: string; kind: 'questions'; max: number }
  | {
      id: string;
      kind: 'message';
      maxSentences?: number;
      minChars?: number;
      match?: string;
      notMatch?: string;
      notEndsWithQuestion?: boolean;
    };

/** A literal, or `{regex}`, or `{min, max}` for numbers and string lengths, or `{absent: true}`. */
export type Match = string | number | boolean | { regex?: string; min?: number; max?: number; oneOf?: unknown[]; absent?: boolean; lengthMin?: number; lengthMax?: number };

export interface Verdict {
  id: string;
  ok: boolean;
  detail: string;
}

/** `mcp__plugin_eklavya_eklavya__record_attempt` and `record_attempt` are one tool. */
export function toolName(raw: string): string {
  return raw.replace(/^mcp__.*?__/, '');
}

const ASKING = new Set(['AskUserQuestion', 'present_question']);

/** Four lettered lines is a question in a renderer that has no tool for it. */
function lettered(message: string): boolean {
  return (message.match(/^\s*\(?[A-D][).]\s+\S/gm) ?? []).length >= 4;
}

export function questionCount(turn: TutorTurn): number {
  const calls = turn.tool_calls.filter((c) => ASKING.has(toolName(c.tool))).length;
  return calls + (lettered(turn.message) ? 1 : 0);
}

function sentences(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((s) => /\w/.test(s)).length;
}

function dig(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function matches(value: unknown, m: Match): boolean {
  if (typeof m !== 'object') return value === m;
  if (m.absent) return value === undefined || value === null || value === '';
  if (m.oneOf) return m.oneOf.includes(value);
  if (m.regex !== undefined) return typeof value === 'string' && new RegExp(m.regex, 'i').test(value);
  if (m.lengthMin !== undefined || m.lengthMax !== undefined) {
    const n = typeof value === 'string' ? value.trim().length : Array.isArray(value) ? value.length : -1;
    return n >= (m.lengthMin ?? 0) && n <= (m.lengthMax ?? Infinity);
  }
  return typeof value === 'number' && value >= (m.min ?? -Infinity) && value <= (m.max ?? Infinity);
}

export function checkTurn(turn: TutorTurn, rules: Rule[]): Verdict[] {
  return rules.map((rule): Verdict => {
    if (rule.kind === 'call') {
      const where = Object.entries(rule.where ?? {});
      const hits = turn.tool_calls.filter((c) => toolName(c.tool) === rule.tool && where.every(([k, m]) => matches(dig(c.args, k), m))).length;
      // A rule that only sets `max: 0` is a prohibition; it must not also demand a call.
      const min = rule.min ?? (rule.max === 0 ? 0 : 1);
      const ok = hits >= min && hits <= (rule.max ?? Infinity);
      return { id: rule.id, ok, detail: `${hits} matching ${rule.tool} call(s), wanted ${min}-${rule.max ?? '∞'}` };
    }
    if (rule.kind === 'questions') {
      const n = questionCount(turn);
      return { id: rule.id, ok: n <= rule.max, detail: `${n} question(s) asked, limit ${rule.max}` };
    }
    const problems: string[] = [];
    const text = turn.message.trim();
    if (rule.maxSentences !== undefined && sentences(text) > rule.maxSentences) problems.push(`${sentences(text)} sentences, limit ${rule.maxSentences}`);
    if (rule.minChars !== undefined && text.length < rule.minChars) problems.push(`${text.length} characters, wanted ${rule.minChars}+`);
    if (rule.match !== undefined && !new RegExp(rule.match, 'is').test(text)) problems.push(`does not match /${rule.match}/`);
    if (rule.notMatch !== undefined && new RegExp(rule.notMatch, 'is').test(text)) problems.push(`matches /${rule.notMatch}/`);
    if (rule.notEndsWithQuestion && text.endsWith('?')) problems.push('ends on a question');
    return { id: rule.id, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'message ok' };
  });
}

export interface ScenarioResult {
  scenario: string;
  trial: number;
  /** The reply could not be read, so no rule was judged. */
  unparsed?: string;
  verdicts: Verdict[];
}

/** Per-rule and per-scenario pass rates; an unparsed reply counts against every rule. */
export function summarise(results: ScenarioResult[]) {
  const byScenario: Record<string, { trials: number; clean: number; unparsed: number; failed: Record<string, number> }> = {};
  for (const r of results) {
    const row = (byScenario[r.scenario] ??= { trials: 0, clean: 0, unparsed: 0, failed: {} });
    row.trials++;
    if (r.unparsed) {
      row.unparsed++;
      continue;
    }
    const bad = r.verdicts.filter((v) => !v.ok);
    if (bad.length === 0) row.clean++;
    for (const v of bad) row.failed[v.id] = (row.failed[v.id] ?? 0) + 1;
  }
  const trials = results.length;
  const clean = Object.values(byScenario).reduce((n, r) => n + r.clean, 0);
  const unparsed = Object.values(byScenario).reduce((n, r) => n + r.unparsed, 0);
  return { trials, clean, unparsed, byScenario };
}
