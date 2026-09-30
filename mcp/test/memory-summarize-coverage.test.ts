import { describe, expect, it } from 'vitest';
import { LocalSummarizer, summarizeSession } from '../src/memory/summarize.js';
import type { EntryRow, EvidenceRow } from '../src/memory/store.js';

let nextId = 1;
function ev(over: Partial<EvidenceRow>): EvidenceRow {
  const id = nextId++;
  return {
    id,
    event_uid: `e${id}`,
    project: '/p',
    checkout: null,
    session_id: 's',
    agent_id: null,
    host: 'claude-code',
    source: 'hook',
    kind: 'tool_use',
    tool: null,
    title: null,
    body: '',
    files: null,
    occurred_at: '2026-09-01T10:00:00.000Z',
    received_at: '2026-09-01T10:00:00.000Z',
    redacted: 0,
    ...over,
  } as EvidenceRow;
}

function obs(i: number, over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: i,
    entry_uid: `u${i}`,
    project: '/p',
    session_id: null,
    batch_id: null,
    kind: 'observation',
    type: 'feature',
    title: `obs ${i}`,
    narrative: '',
    facts: null,
    files: null,
    generator: 'local-v1',
    confidence: 0.9,
    occurred_at: `2026-09-01T10:${String(i).padStart(2, '0')}:00.000Z`,
    created_at: '2026-09-01T10:00:00.000Z',
    superseded_by: null,
    deleted_at: null,
    import_source: null,
    ...over,
  };
}

const local = new LocalSummarizer();
const run = (events: EvidenceRow[]) => local.summarize({ project: '/p', sessionId: 's', events });

describe('LocalSummarizer', () => {
  it('writes nothing for an empty batch or one of session markers only', async () => {
    expect(await run([])).toEqual([]);
    expect(await run([ev({ kind: 'lifecycle' }), ev({ kind: 'lifecycle' })])).toEqual([]);
  });

  it('falls back to an event title for intent, and treats bad file columns as no files', async () => {
    const [draft] = await run([
      ev({ kind: 'tool_use', title: 'Ran the migration', files: '{"not":"a list"}' }),
      ev({ kind: 'tool_use', files: 'not json' }),
    ]);
    expect(draft!.title).toBe('Ran the migration');
    expect(draft!.files).toEqual([]);
    expect(draft!.type).toBe('change');
  });

  it('titles a prompt-less, title-less batch by its first file, or as session work', async () => {
    const [withFile] = await run([ev({ kind: 'file_edit', files: JSON.stringify(['lib/db/pool.ts']) })]);
    expect(withFile!.title).toBe('Worked on lib/db/pool.ts');
    expect(withFile!.narrative).toBe('Edited 1 time(s) across 1 file(s).');
    expect(withFile!.tags).toEqual(['ts', 'lib']);

    const [bare] = await run([ev({ kind: 'tool_use' })]);
    expect(bare!.title).toBe('Session work');
    expect(bare!.narrative).toBe('');
  });

  it('calls a hint-less batch with a failure a bugfix and quotes later prompts', async () => {
    const long = 'x'.repeat(120);
    const [draft] = await run([
      ev({ kind: 'prompt', body: long }),
      ev({ kind: 'tool_error', body: 'exit 1' }),
      ev({ kind: 'prompt', body: 'second' }),
    ]);
    expect(draft!.type).toBe('bugfix');
    expect(draft!.title).toBe(`${'x'.repeat(89)}…`);
    expect(draft!.narrative).toContain('Then asked: second');
    expect(draft!.facts).toContain('Failed: exit 1');
    expect(draft!.tags).toContain('failure');
  });
});

describe('summarizeSession', () => {
  it('needs two observations', () => {
    expect(summarizeSession([obs(1)])).toBeNull();
  });

  it('lists at most twelve, counts untyped as change and takes the lowest confidence', () => {
    const rows = Array.from({ length: 14 }, (_, i) => obs(i + 1, { type: null, confidence: i === 3 ? null : 0.9 }));
    const s = summarizeSession(rows)!;
    expect(s.type).toBe('change');
    expect(s.narrative).toContain('- change: obs 1');
    expect(s.narrative).toContain('- …and 2 more.');
    expect(s.narrative).not.toContain('obs 13');
    expect(s.confidence).toBe(0.5);
    expect(s.title).toBe('Session: obs 1');
    expect(s.tags).toEqual(['session']);
  });

  it('uses the request as the title when one is on record', () => {
    const s = summarizeSession([obs(2), obs(1)], '  fix the login  ')!;
    expect(s.title).toBe('fix the login');
    expect(s.narrative).not.toContain('more.');
    expect(summarizeSession([obs(2), obs(1)], '   ')!.title).toBe('Session: obs 1');
  });
});
