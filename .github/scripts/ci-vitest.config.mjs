import config from '../../mcp/vitest.config.ts';
import CISequencer from './ci-sequencer.mjs';

// Reuse all local test and whole-process coverage settings. The CI-only
// override controls execution order without changing test discovery.
export default {
  ...config,
  test: { ...config.test, sequence: { ...config.test.sequence, sequencer: CISequencer } },
};
