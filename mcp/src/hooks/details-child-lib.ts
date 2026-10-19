/**
 * Child process of `details-lib.ts`: computes ONE of the greeting's
 * optional details (argv[2] names it) and writes it as a JSON line, so the hook
 * can kill this process if it is too slow. The specification is argv[3]. Fails open: any failure leaves its detail unwritten.
 */
import { writeSync } from 'node:fs';
import type { DetailName, DetailsSpec } from './details-lib.js';
import { openExisting } from './lib.js';
import { memoryHealthLine, recallBlock } from './memory-lib.js';
import { learningCounts } from '../memory/recall.js';
import { levelStanding } from '../store.js';

/** A test seam: `EKLAVYA_TEST_STALL=<detail>` blocks this process, standing in for a slow query. */
function stall(detail: string): void {
  /* c8 ignore next -- the stalled child is killed before it can report coverage */
  if (process.env.EKLAVYA_TEST_STALL === detail) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
}

function send(part: object): void {
  writeSync(1, `${JSON.stringify(part)}\n`);
}

function main(): void {
  const spec = JSON.parse(process.argv[3]!) as DetailsSpec;
  const db = openExisting();
  /* c8 ignore next -- the hook opened this database a moment ago; defensive */
  if (!db) return;
  const { resolved, identity } = spec;
  const steps: Record<DetailName, () => object> = {
    counts: () => ({ counts: learningCounts(db, identity.project) }),
    level: () => {
      const standing = levelStanding(db, resolved.config, resolved.repoRoot);
      return { levelLabel: `${standing.level} (${standing.counts.passed}/${standing.needed.answers})` };
    },
    recall: () => ({ recalled: recallBlock(db, resolved, identity, 'session_start', spec.resume, spec.recallChars) }),
    health: () => ({ memoryLine: memoryHealthLine(db, Date.now(), identity.project) }),
  };
  const name = process.argv[2] as DetailName;
  stall(name);
  send(steps[name]());
}

try {
  main();
/* c8 ignore next 3 -- every step fails open inside its own function; defensive */
} catch {
  /* nothing to report */
}
process.exit(0);
