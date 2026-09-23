import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

/**
 * What the hot paths load, pinned.
 *
 * `capture-tool` runs after every tool call, `prompt-submit-nudge` on every
 * prompt, and `eklavya statusline` on every status-bar refresh. An ES import is
 * paid whether or not the function behind it is ever called, so one convenient
 * import from `memory-lib.ts` or one more static import at the top of `cli.ts`
 * quietly puts the worker, the provider (and zod), recall, notify, install and
 * the dashboard back on every one of those — about 15ms a tool call and 30ms a
 * refresh, measured, with every other test still green. So the built entry is
 * run in a child with a resolve hook that records every module it pulls in,
 * and the heavy ones are asserted absent.
 *
 * Each case also asserts one module the path *does* need, so a recorder that
 * saw nothing cannot pass for an isolated graph.
 */

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(mcpRoot, 'dist');

// Synchronous, in-thread resolve hooks: Node 22.15+, which every current 22.x
// (and CI's `node-version: '22'`) has. The recorder writes the list at exit
// because stdout is the hook protocol and must stay untouched.
const RECORDER = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const seen = new Set();
registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.add(r.url); return r; } });
process.on('exit', () => writeFileSync(process.env.RECORD_TO, JSON.stringify([...seen])));
`)}`;

/** Modules no hot path may load, as paths under dist/ (or a package name). */
const MEMORY_HEAVY = [
  'memory/worker.js',
  'memory/provider.js',
  'memory/summarize.js',
  'memory/notify.js',
  'memory/import.js',
  'memory/import-worker.js',
  'memory/sync.js',
  'memory/replay.js',
  'hooks/memory-lib.js',
  'dashboard.js',
  'install.js',
  'cli-memory.js',
  'zod',
];

let home = '';
let cwd = '';

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-isolation-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-isolation-cwd-'));
  // Memory on explicitly, so the capture path runs end to end rather than
  // returning at the config check — whatever the default becomes.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ memory: { enabled: true } }));
  openDb(path.join(home, 'knowledge.db')).close();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** Runs a built entry under the recorder; returns what it loaded, relative to dist/ (packages by name). */
function loaded(entry: string, args: string[], input: object): string[] {
  const record = path.join(home, `record-${path.basename(entry)}-${args.join('-')}.json`);
  const res = spawnSync(process.execPath, ['--import', RECORDER, path.join(dist, entry), ...args], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      EKLAVYA_HOME: home,
      EKLAVYA_DB: path.join(home, 'knowledge.db'),
      RECORD_TO: record,
    },
  });
  expect(res.status, res.stderr).toBe(0);
  const urls = JSON.parse(fs.readFileSync(record, 'utf8')) as string[];
  return urls
    .filter((u) => u.startsWith('file:'))
    .map((u) => fileURLToPath(u))
    .map((p) =>
      p.includes(`${path.sep}node_modules${path.sep}`)
        ? p.split(`${path.sep}node_modules${path.sep}`).pop()!.split(path.sep)[0]!
        : path.relative(dist, p).split(path.sep).join('/'),
    );
}

const hasSyncHooks = typeof (module as { registerHooks?: unknown }).registerHooks === 'function';

describe.skipIf(!hasSyncHooks)('hot paths load only what they run', () => {
  it('capture-tool records an event without the seam graph', () => {
    const mods = loaded('hooks/capture-tool.js', [], {
      session_id: 'iso',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: { stdout: 'x' },
    });
    expect(mods).toContain('memory/capture.js');
    for (const heavy of [...MEMORY_HEAVY, 'memory/recall.js', 'memory/search.js']) {
      expect(mods, `capture-tool loaded ${heavy}`).not.toContain(heavy);
    }
  });

  it('prompt-submit-nudge records and recalls without the seam graph', () => {
    const mods = loaded('hooks/prompt-submit-nudge.js', [], {
      session_id: 'iso',
      cwd,
      prompt: 'how does the capture path decide what to record',
    });
    // Recall is this hook's job; the worker, provider and notify are not.
    expect(mods).toContain('memory/recall.js');
    for (const heavy of MEMORY_HEAVY) {
      expect(mods, `prompt-submit-nudge loaded ${heavy}`).not.toContain(heavy);
    }
  });

  it('eklavya statusline loads neither the database opener nor any subcommand', () => {
    const mods = loaded('cli.js', ['statusline'], { session_id: 'iso', cwd });
    expect(mods).toContain('statusline.js');
    for (const heavy of [...MEMORY_HEAVY, 'db.js', 'migrate.js', 'seed.js', 'packs.js', 'server.js', 'memory/store.js']) {
      expect(mods, `statusline loaded ${heavy}`).not.toContain(heavy);
    }
  });

  it('a memory subcommand still gets the memory half', () => {
    // The other side of the boundary: lazy is not the same as missing.
    const mods = loaded('cli.js', ['memory', 'status'], {});
    expect(mods).toContain('cli-memory.js');
    expect(mods).toContain('memory/worker.js');
  });
});
