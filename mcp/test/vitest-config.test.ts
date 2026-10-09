import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

/**
 * Several suites spawn real hooks, workers and `claude` stand-ins. Under the
 * full suite (and more under c8) the machine is loaded, and those tests failed
 * at vitest's default 5 seconds while passing alone and on rerun: three
 * different ones across a handful of gate runs. The limit is for a hung test,
 * not for a slow machine.
 */
describe('the test runner', () => {
  it('gives a spawned process time to finish on a loaded machine', () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(30_000);
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(30_000);
  });
});
