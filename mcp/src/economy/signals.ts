// Translated and adapted from microsoft/TokenEconomizer,
// tokeneconomizer/loopguard/state.py at d3e193b8734ec76230da1e08d7929ba9d14640d8.
// Licensed under the Apache License, Version 2.0 (see ./LICENSE in this folder).
// Changes: ported from Python to TypeScript; Claude Code tool names only; the
// Go `FAIL` lines use a second, case-sensitive pattern (JavaScript has no
// inline flag groups); a host-reported failure counts as an error output even
// without an error marker; more test runners are recognised; a verification verdict is kept so a turn that edited
// after its last check reads as unknown, not green; shell edits are folded in
// `update` rather than by the caller.

import crypto from 'node:crypto';
import { basename, shellEditTargets } from './shell-edits.js';

/** An output that ran code to verify behaviour: the test step of the edit→test loop. */
export const TEST_RUN_RE =
  /(runtests(\.py)?|\bpytest\b|py\.test|manage\.py\s+test|python\s+-m\s+unittest|\btox\b|\bnox\b|\btrial\b|python\d?\s+-c\b|\bnpm (?:run )?test\b|\bnpx (?:vitest|jest|mocha)\b|\bvitest\b|\bjest\b|\bgo test\b|\bcargo test\b|\bmvn (?:-\S+ )*test\b|\bgradlew? test\b|\brspec\b|node --test\b)/i;
const ERR_RE =
  /(Traceback \(most recent call last\)|\b\w*Error\b|\bFAILED\b|\bassert\b|Exception|errors during collection|^# fail [1-9]|^not ok \d|\b[1-9]\d* (?:failing|failures?)\b|Failures: [1-9])/im;
/** Go's `--- FAIL: T` and `FAIL<tab>pkg`, case-sensitive so unittest's `FAIL: test_x` keeps its own line. */
const GO_FAIL_RE = /^(?:--- FAIL: |FAIL\t|FAIL$)/m;
export const isErrorText = (text: string): boolean => ERR_RE.test(text) || GO_FAIL_RE.test(text);

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Tools whose output is file content, not the outcome of running anything. */
const CONTENT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/**
 * A normalised signature of a failing output: numbers, addresses and paths
 * dropped, so two runs that fail the same way hash the same. A hash, never
 * the content.
 */
export function failureSignature(text: string): string | null {
  if (!text) return null;
  const first = text.split('\n').find((ln) => isErrorText(ln));
  if (first === undefined) return null;
  const norm = first.replace(/0x[0-9a-f]+|\d+|\/\S+/g, '').trim();
  return crypto.createHash('md5').update(norm).digest('hex').slice(0, 10);
}

export type Verdict = 'green' | 'red' | 'unknown';

export interface TurnSnapshot {
  calls: number;
  edit_churn: number;
  distinct_edit_files: number;
  error_outputs: number;
  test_runs: number;
  stagnation: number;
  repeated_fail_sigs: number;
}

/** What `TurnState` keeps between hook calls: counts only, never content. */
export interface TurnData {
  calls: number;
  editCounts: Record<string, number>;
  errorOutputs: number;
  testRuns: number;
  failSigs: Record<string, number>;
  repeatedFailSigs: number;
  /** The last verification's outcome; reset to null by a later edit. */
  lastCheck: 'green' | 'red' | null;
  /** Did the turn edit anything at all? */
  edited: boolean;
  /** Short action log for a judge digest: tool, command template, basename, error signature. */
  recent: string[];
}

export const emptyTurn = (): TurnData => ({
  calls: 0,
  editCounts: {},
  errorOutputs: 0,
  testRuns: 0,
  failSigs: {},
  repeatedFailSigs: 0,
  lastCheck: null,
  edited: false,
  recent: [],
});

/** Numbers and quoted strings replaced, so a digest carries a command's shape, not its data. */
export const commandTemplate = (cmd: string): string =>
  cmd
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(['"])(?:(?!\1).)*\1/g, '$1…$1')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 90);

/**
 * One turn's failure-loop signals, folded one completed tool call at a time:
 * edits per file, files edited, error outputs, verification runs and how often
 * a failure repeats one seen before (`stagnation`).
 */
export class TurnState {
  constructor(readonly d: TurnData = emptyTurn()) {}

  get editChurn(): number {
    const v = Object.values(this.d.editCounts);
    return v.length ? Math.max(...v) : 0;
  }

  get distinctEditFiles(): number {
    return Object.keys(this.d.editCounts).length;
  }

  /** Share of failing outputs that repeat an earlier identical failure. */
  get stagnation(): number {
    const total = Object.values(this.d.failSigs).reduce((a, b) => a + b, 0);
    return total ? this.d.repeatedFailSigs / total : 0;
  }

  /**
   * Green only when a verification ran after the last edit and passed; a turn
   * that edited and never checked is unknown, and so is one with no edits.
   */
  get verdict(): Verdict {
    if (this.d.lastCheck === 'red') return 'red';
    if (this.d.edited && this.d.lastCheck === 'green') return 'green';
    return 'unknown';
  }

  private edit(name: string): void {
    this.d.editCounts[name] = (this.d.editCounts[name] ?? 0) + 1;
    this.d.edited = true;
    this.d.lastCheck = null;
  }

  /**
   * Fold one completed call. `failed` is what the host said: true for a tool
   * error, false for success, null when it did not say. A call known to have
   * succeeded is never a failing output; a content tool only when the tool
   * itself failed; otherwise the output's own markers decide.
   */
  update(tool: string, args: Record<string, unknown>, result: string, failed: boolean | null): void {
    this.d.calls++;
    let action = tool || '?';
    if (EDIT_TOOLS.has(tool)) {
      const b = basename(String(args.file_path ?? args.notebook_path ?? args.path ?? ''));
      if (b) {
        this.edit(b);
        action = `edit ${b}`;
      }
    }
    const cmd = tool === 'Bash' && typeof args.command === 'string' ? args.command : '';
    let isTest = false;
    if (cmd) {
      action = `$ ${commandTemplate(cmd)}`;
      for (const b of shellEditTargets(cmd)) this.edit(b);
      if (TEST_RUN_RE.test(cmd)) {
        isTest = true;
        this.d.testRuns++;
      }
    }
    const canFail = CONTENT_TOOLS.has(tool) ? failed === true : failed !== false;
    let sig: string | null = null;
    // A failure the host reported counts whatever its text says (`ls: cannot
    // access` names no Error); otherwise the output's markers decide.
    const errored = canFail && (failed === true || (Boolean(result) && isErrorText(result)));
    if (errored) {
      this.d.errorOutputs++;
      sig = failureSignature(result);
      if (sig) {
        if (this.d.failSigs[sig]) this.d.repeatedFailSigs++;
        this.d.failSigs[sig] = (this.d.failSigs[sig] ?? 0) + 1;
      }
    }
    if (isTest) this.d.lastCheck = errored ? 'red' : 'green';
    this.d.recent.push(`${this.d.calls}: ${action}${sig ? `  [err#${sig}]` : ''}`);
    if (this.d.recent.length > 40) this.d.recent = this.d.recent.slice(-40);
  }

  snapshot(): TurnSnapshot {
    return {
      calls: this.d.calls,
      edit_churn: this.editChurn,
      distinct_edit_files: this.distinctEditFiles,
      error_outputs: this.d.errorOutputs,
      test_runs: this.d.testRuns,
      stagnation: Math.round(this.stagnation * 1000) / 1000,
      repeated_fail_sigs: this.d.repeatedFailSigs,
    };
  }

  /** The judge's digest: counts and the recent action log, never file content or output. */
  digest(envelope: number | null, n = 24): string {
    const s = this.snapshot();
    let head =
      `calls=${s.calls} edit_churn=${s.edit_churn} distinct_edit_files=${s.distinct_edit_files} ` +
      `error_outputs=${s.error_outputs} test_runs=${s.test_runs} repeated_identical_failures=${s.repeated_fail_sigs} ` +
      `stagnation=${this.stagnation.toFixed(2)}`;
    if (envelope) {
      head +=
        `\nrepo_context: turns here that end green usually finish within ~${Math.round(envelope)} calls; ` +
        `this turn is at ${s.calls} calls = ${(s.calls / envelope).toFixed(1)}x that. Checks are not green.`;
    }
    return `${head}\nRecent actions (oldest->newest):\n${this.d.recent.slice(-n).join('\n')}`;
  }
}
