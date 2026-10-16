import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readManifest } from './shard-plan.mjs';

// This CI-only module lives outside mcp/, whose locked Vitest is the runner.
const require = createRequire(new URL('../../mcp/package.json', import.meta.url));
const { BaseSequencer } = await import(pathToFileURL(require.resolve('vitest/node')).href);

const priority = spec => spec.moduleId.endsWith('dashboard-screens-browser.test.ts') ? 2
  : spec.moduleId.endsWith('-browser.test.ts') ? 1 : 0;

export default class CISequencer extends BaseSequencer {
  // Shard membership comes from test-shards.json, not Vitest's path hash: the
  // hash split the suite 4 minutes against 6. A file missing from the manifest
  // throws, so a new test can never be skipped by every shard.
  async shard(specs) {
    const { index, count } = this.ctx.config.shard;
    const manifest = readManifest();
    if (count !== manifest.count) throw new Error(`--shard=${index}/${count} but test-shards.json has ${manifest.count} shards`);
    const name = spec => path.relative(this.ctx.config.root, spec.moduleId).split(path.sep).join('/');
    const unassigned = specs.filter(spec => !manifest.files[name(spec)]).map(name);
    if (unassigned.length) {
      throw new Error(`Not in .github/scripts/test-shards.json: ${unassigned.join(', ')}. Run: node .github/scripts/shard-plan.mjs add <file> [seconds]`);
    }
    return specs.filter(spec => manifest.files[name(spec)].shard === index);
  }

  // Only execution order changes here: a small browser file can take far
  // longer than a large unit file.
  async sort(specs) {
    const ordered = await super.sort(specs);
    return ordered.sort((a, b) => priority(b) - priority(a));
  }
}
