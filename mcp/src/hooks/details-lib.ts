/**
 * The optional details of the session-start greeting, computed under a budget.
 *
 * Claude Code kills a hook at its timeout (10 seconds, `hooks/hooks.json`) and
 * shows nothing of it: one slow query used to cost the whole banner, the recalled
 * memory and the directive. better-sqlite3 is synchronous, so a timer in this
 * process cannot interrupt a query; a worker thread is no better, because
 * `process.exit` waits for a thread stuck in native code (measured: a 25-second
 * query held the exit for 25 seconds). So the details run in a child process
 * (`details-child-lib.ts`) that this one can SIGKILL. Each detail gets its
 * own child, run in parallel, so a slow one never holds up the others; whatever
 * finished before the deadline is used and the rest is left out.
 *
 * Light on purpose: this file loads in the hook, the child carries the weight.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResolvedConfig } from '../config.js';
import type { EvidenceIdentity } from '../memory/identity.js';
import type { LearningCounts, RecallResult } from '../memory/recall.js';

/** Total hook time the optional details may use, counted from process start. The host kills at 10s. */
export const HOOK_BUDGET_MS = 7_000;

export type DetailName = 'counts' | 'level' | 'recall' | 'health';

export interface DetailsSpec {
  resolved: ResolvedConfig;
  identity: EvidenceIdentity;
  /** A resume already holds this session's own entries. */
  resume: boolean;
  /** Characters the recalled block may use (the `recall` detail). */
  recallChars: number;
  /** Which details to compute; the rest are never started. */
  want: DetailName[];
}

export interface Details {
  recalled?: RecallResult | null;
  /** Present once computed; null means healthy. */
  memoryLine?: string | null;
  counts?: LearningCounts;
  levelLabel?: string;
}

/** `EKLAVYA_SESSION_START_BUDGET_MS` lets a test shrink the budget. */
export function budgetMs(): number {
  const set = Number(process.env.EKLAVYA_SESSION_START_BUDGET_MS);
  return Number.isFinite(set) && set > 0 ? set : HOOK_BUDGET_MS;
}

/**
 * Runs one child per detail and returns what they reported in time. Never throws,
 * never waits past the budget: a spawn failure or a crash is the same as nothing ready.
 */
export function collectDetails(spec: DetailsSpec): Promise<Details> {
  const out: Details = {};
  const left = budgetMs() - process.uptime() * 1000;
  if (left <= 0) return Promise.resolve(out);
  const children = spec.want.map((only) => {
    return new Promise<void>((resolve) => {
      let buffer = '';
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./details-child-lib.js', import.meta.url)), only, JSON.stringify(spec)],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), left);
      // 'close' follows a kill too, so the promise always settles.
      child.on('close', () => {
        clearTimeout(timer);
        for (const line of buffer.split('\n')) {
          try {
            Object.assign(out, JSON.parse(line) as Details);
          } catch {
            /* an empty or partial line: that detail is left out */
          }
        }
        resolve();
      });
      child.on('error', () => resolve());
      child.stdout.on('data', (chunk: Buffer) => (buffer += chunk.toString('utf8')));
    });
  });
  // ponytail: each detail costs a node start (~100ms of CPU); one child per detail is what keeps a slow one from queueing the rest.
  return Promise.all(children).then(() => out);
}
