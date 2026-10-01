import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { prepare } from '../src/memory/capture.js';
import { identityFor } from '../src/memory/identity.js';
import { replayProject, replayTranscript, transcriptDirFor, transcriptsFor } from '../src/memory/replay.js';
import { appendEvent } from '../src/memory/store.js';

const config = (): EklavyaConfig => structuredClone(DEFAULT_CONFIG);

let dbFile: string;
let db: DB;
let home: string;
let cwd: string;
let priorHome: string | undefined;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-replay-cov');
  db = openDb(dbFile);
  priorHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-replay-home-'));
  process.env.HOME = home;
  cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
});
afterEach(() => {
  process.env.HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
  db.close();
  cleanup(dbFile);
});

const bodies = () =>
  (db.prepare('SELECT kind, tool, body FROM evidence_events ORDER BY id').all() as { kind: string; tool: string | null; body: string }[]);

function transcript(name: string, lines: unknown[]): string {
  const dir = transcriptDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return file;
}

describe('transcriptsFor / replayProject', () => {
  it('finds nothing when the host has no transcripts for the checkout', () => {
    expect(transcriptsFor(cwd)).toEqual([]);
    expect(replayProject(db, config(), cwd)).toEqual([]);
  });

  it('replays the newest transcripts only, sorted, ignoring other files', () => {
    transcript('a.jsonl', [{ type: 'user', sessionId: 'sa', message: { content: 'first prompt about the cookie' } }]);
    transcript('b.jsonl', [{ type: 'user', sessionId: 'sb', message: { content: 'second prompt about the cookie' } }]);
    transcript('notes.txt', ['ignored']);
    expect(transcriptsFor(cwd).map((f) => path.basename(f))).toEqual(['a.jsonl', 'b.jsonl']);

    const results = replayProject(db, config(), cwd, { limit: 1 });
    expect(results.map((r) => [path.basename(r.file), r.captured])).toEqual([['b.jsonl', 1]]);
    expect(bodies().map((b) => b.body)).toEqual(['second prompt about the cookie']);
  });
});

describe('replayTranscript line shapes', () => {
  it('reads text blocks, skips junk, and defaults missing inputs', () => {
    const file = transcript('s.jsonl', [
      { type: 'system', message: { content: 'not a turn' } },
      {
        type: 'user',
        cwd,
        message: { content: [null, 'bare string', { type: 'image' }, { type: 'text', text: 'explain the refresh flow' }, { type: 'text', text: 7 }] },
      },
      { type: 'user', message: { content: { not: 'a list' } } },
      { type: 'assistant', message: { content: 'plain text, no tools' } },
      {
        type: 'assistant',
        message: {
          content: [
            null,
            'x',
            { type: 'tool_use', name: 'NoInput' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } },
            { type: 'tool_use', name: 7 },
          ],
        },
      },
    ]);

    const result = replayTranscript(db, config(), file);
    expect(result).toEqual({ file, read: 4, captured: 2, duplicates: 0, excluded: 0 });
    expect(bodies()).toEqual([
      { kind: 'prompt', tool: null, body: 'explain the refresh flow' },
      { kind: 'tool_use', tool: 'Bash', body: 'npm run build' },
    ]);
    // No cwd on the line or in opts: the session falls back to 'replay'.
    expect(db.prepare('SELECT DISTINCT session_id FROM evidence_events').all()).toEqual([{ session_id: 'replay' }]);
  });

  it('counts an event whose identity is already taken by a different row as a duplicate', () => {
    const line = { type: 'user', cwd, sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'the prompt text here' } };
    const input = prepare(config(), identityFor({ cwd, sessionId: 's1', host: 'claude-code' }), {
      kind: 'prompt',
      title: 'prompt',
      body: 'the prompt text here',
      occurredAt: line.timestamp,
      source: 'replay',
    })!;
    // Same event_uid, different body: the content check misses, the insert is ignored.
    appendEvent(db, { ...input, body: 'something else' });
    const result = replayTranscript(db, config(), transcript('d.jsonl', [line]));
    expect(result).toMatchObject({ read: 1, captured: 0, duplicates: 1 });
  });
});
