import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The worker re-opens its own module file on a thread, so it must be the built
// JavaScript: a `.ts` URL cannot be loaded by a plain worker thread.
import { importOffThread } from '../dist/memory/import-worker.js';
import { buildSource } from './claude-mem-fixture.js';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-import-worker-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('importOffThread', () => {
  it('imports on a worker thread and returns the report, the verification and unsure names', async () => {
    const source = path.join(dir, 'claude-mem.db');
    buildSource(source);
    const claudeHome = path.join(dir, 'claude');
    fs.mkdirSync(claudeHome);
    const out = await importOffThread({
      dbFile: path.join(dir, 'knowledge.db'),
      source,
      opts: { snapshotDir: path.join(dir, 'snap'), projectMap: { 'demo-repo': '/work/demo-repo' } },
      guessFrom: claudeHome,
    });
    expect(out.report.imported.observations).toBe(2);
    expect(out.report.projectsMapped).toEqual([{ from: 'demo-repo', to: '/work/demo-repo' }]);
    expect(out.verified.tables.every((t: { missing: number[] }) => t.missing.length === 0)).toBe(true);
    expect(out.unsure).toEqual({});
  });

  it('rejects with an ImportError when the importer refuses the source', async () => {
    const err = await importOffThread({ dbFile: path.join(dir, 'knowledge.db'), source: path.join(dir, 'missing.db'), opts: {} }).catch((e: Error) => e);
    expect((err as Error).constructor.name).toBe('ImportError');
    expect((err as Error).message).toMatch(/No Claude Mem database/);
  });

  it('rejects with a plain Error when anything else fails', async () => {
    // A directory where the database file should be cannot be opened.
    const err = await importOffThread({ dbFile: dir, source: path.join(dir, 'missing.db'), opts: {} }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor.name).toBe('Error');
  });
});
