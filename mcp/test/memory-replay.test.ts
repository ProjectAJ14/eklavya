import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { replayTranscript, transcriptDirFor } from '../src/memory/replay.js';
import { capture } from '../src/memory/capture.js';
import { identityFor } from '../src/memory/identity.js';
import { capabilitiesOf, provenHosts } from '../src/memory/hosts.js';

let dbFile: string;
let db: DB;
let dir: string;
let config: EklavyaConfig;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-replay');
  db = openDb(dbFile);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-transcript-'));
  config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A transcript in the shape Claude Code writes: one JSON object per line. */
function transcript(lines: unknown[]): string {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return file;
}

const CWD = '/tmp/replay-repo';

function userLine(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    cwd: CWD,
    sessionId: 'replay-1',
    timestamp: '2026-09-20T10:00:00.000Z',
    message: { role: 'user', content: text },
    ...extra,
  };
}

function assistantLine(tool: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    cwd: CWD,
    sessionId: 'replay-1',
    timestamp: '2026-09-20T10:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: tool, input }] },
  };
}

describe('transcript replay', () => {
  it('captures the prompts and tool uses a hook never saw', () => {
    const file = transcript([
      userLine('Add refresh token rotation'),
      assistantLine('Edit', { file_path: `${CWD}/src/auth.ts`, old_string: 'a', new_string: 'b' }),
      assistantLine('Bash', { command: 'npm test' }),
    ]);
    const result = replayTranscript(db, config, file, { cwd: CWD });
    expect(result.captured).toBe(3);
    const kinds = (db.prepare('SELECT kind FROM evidence_events ORDER BY id').all() as { kind: string }[]).map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(['prompt', 'file_edit', 'tool_use']);
  });

  it('keeps the host timestamp rather than the time the replay ran', () => {
    // A replayed session belongs where it happened. Stamping it with now would
    // put last month's work at the top of this week's timeline.
    const file = transcript([userLine('Add refresh token rotation')]);
    replayTranscript(db, config, file, { cwd: CWD });
    const row = db.prepare('SELECT occurred_at, source FROM evidence_events').get() as {
      occurred_at: string;
      source: string;
    };
    expect(row.occurred_at).toBe('2026-09-20T10:00:00.000Z');
    expect(row.source).toBe('replay');
  });

  it('is idempotent, so replaying the same file twice records nothing new', () => {
    const file = transcript([userLine('Add refresh token rotation'), assistantLine('Bash', { command: 'npm test' })]);
    replayTranscript(db, config, file, { cwd: CWD });
    const second = replayTranscript(db, config, file, { cwd: CWD });
    expect(second.captured).toBe(0);
    expect(second.duplicates).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n).toBe(2);
  });

  it('converges with hook capture instead of recording the same work twice', () => {
    // The two sides stamp different times for the same event, so the shared
    // event_uid cannot deduplicate them. This is the case that proves the
    // content check does.
    const identity = identityFor({ cwd: CWD, sessionId: 'replay-1' });
    capture(db, config, identity, { kind: 'tool_use', tool: 'Bash', title: 'Bash', body: 'npm test' });
    const file = transcript([assistantLine('Bash', { command: 'npm test' })]);
    const result = replayTranscript(db, config, file, { cwd: CWD });
    expect(result.captured).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n).toBe(1);
  });

  it('applies the privacy filter on the replay path too', () => {
    const file = transcript([
      assistantLine('Bash', { command: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' }),
      assistantLine('Read', { file_path: `${CWD}/.env.local` }),
    ]);
    replayTranscript(db, config, file, { cwd: CWD });
    const bodies = (db.prepare('SELECT body FROM evidence_events').all() as { body: string }[]).map((r) => r.body);
    expect(bodies.join('\n')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    // The `.env` read was excluded outright, so only the redacted Bash line is here.
    expect(bodies).toHaveLength(1);
  });

  it('skips a subagent sidechain, which the parent transcript already records', () => {
    const file = transcript([userLine('do the thing', { isSidechain: true })]);
    expect(replayTranscript(db, config, file, { cwd: CWD }).read).toBe(0);
  });

  it('ignores a tool result echoed back as a user line', () => {
    // The host writes tool results as user-role lines. Treating one as a prompt
    // would record the agent's own output as something the developer typed.
    const file = transcript([userLine('output of the command', { toolUseResult: { stdout: 'ok' } })]);
    expect(replayTranscript(db, config, file, { cwd: CWD }).captured).toBe(0);
  });

  it('survives a truncated or unreadable transcript without throwing', () => {
    const file = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(file, '{"type":"user","message":{"content":"ok"},"cwd":"/tmp/x"}\n{not json\n', 'utf8');
    expect(() => replayTranscript(db, config, file, { cwd: CWD })).not.toThrow();
    expect(replayTranscript(db, config, path.join(dir, 'missing.jsonl'), { cwd: CWD }).read).toBe(0);
  });

  it('names the directory Claude Code actually writes transcripts to', () => {
    expect(transcriptDirFor('/Users/x/code/repo')).toContain('-Users-x-code-repo');
  });
});

describe('host capabilities', () => {
  it('claims only the hosts a fixture has actually been run through', () => {
    expect(provenHosts().map((h) => h.id)).toEqual(['claude-code']);
  });

  it('assumes nothing about a host it does not recognise', () => {
    // Failing open here would mean a memory that implies every tool succeeded
    // on a host that never reports failures.
    const unknown = capabilitiesOf('some-new-editor');
    expect(unknown.status).toBe('unverified');
    expect(unknown.toolOutcomes).toBe(false);
    expect(unknown.hooks).toBe(false);
  });
});
