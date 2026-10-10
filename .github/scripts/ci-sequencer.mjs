import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// This CI-only module lives outside mcp/, whose locked Vitest is the runner.
const require = createRequire(new URL('../../mcp/package.json', import.meta.url));
const { BaseSequencer } = await import(pathToFileURL(require.resolve('vitest/node')).href);

const priority = spec => spec.moduleId.endsWith('dashboard-screens-browser.test.ts') ? 2
  : spec.moduleId.endsWith('-browser.test.ts') ? 1 : 0;

export default class CISequencer extends BaseSequencer {
  // Keep Vitest's native hash-based shard assignment. Only execution order
  // changes: a small browser file can take far longer than a large unit file.
  async sort(specs) {
    const ordered = await super.sort(specs);
    return ordered.sort((a, b) => priority(b) - priority(a));
  }
}
