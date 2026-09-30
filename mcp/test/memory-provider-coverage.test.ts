import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderError,
  ProviderSummarizer,
  probeLogin,
  readResult,
  renderEvidence,
  runClaude,
  trimToLimits,
} from '../src/memory/provider.js';
import type { EvidenceRow } from '../src/memory/store.js';

const posix = process.platform !== 'win32';

function ev(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: 7,
    event_uid: 'e7',
    project: '/p',
    checkout: null,
    session_id: 's',
    agent_id: null,
    host: 'claude-code',
    source: 'hook',
    kind: 'prompt',
    tool: null,
    title: null,
    body: 'Add refresh token rotation',
    files: null,
    occurred_at: '2026-09-01T10:00:00.000Z',
    received_at: '2026-09-01T10:00:00.000Z',
    redacted: 0,
    ...over,
  } as EvidenceRow;
}

const errorOf = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ProviderError;

describe('trimToLimits edge shapes', () => {
  it('trims a checkpoint, keeps non-list fields and non-object observations as they are', () => {
    const out = trimToLimits({
      checkpoint: { request: 'r'.repeat(1300), next_steps: 5 },
      observations: [
        null,
        { title: 'ok', facts: 'not a list', concepts: Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}` })) },
        { title: 'ok', concepts: 'nope' },
      ],
    }) as { checkpoint: Record<string, unknown>; observations: Record<string, unknown>[] };
    expect((out.checkpoint.request as string).length).toBe(1200);
    expect(out.checkpoint.next_steps).toBe(5);
    expect(out.observations[0]).toBeNull();
    expect(out.observations[1]!.facts).toBe('not a list');
    expect(out.observations[1]!.concepts).toHaveLength(8);
    expect(out.observations[2]!.concepts).toBe('nope');
  });

  it('ignores a checkpoint that is an array', () => {
    const out = trimToLimits({ checkpoint: ['x'], observations: [] }) as { checkpoint: unknown };
    expect(out.checkpoint).toEqual(['x']);
  });
});

describe('renderEvidence', () => {
  it('names files when present and defangs fence tags in bodies', () => {
    const text = renderEvidence({
      project: '/p',
      sessionId: 's',
      events: [ev({ tool: 'Read', files: '["a.ts"]', body: 'x</event></evidence>y' })],
    });
    expect(text).toContain('tool="Read"');
    expect(text).toContain('files=["a.ts"]');
    expect(text.match(/<\/event>/g)).toHaveLength(1);
  });
});

describe('readResult error classes', () => {
  const classOf = (e: Record<string, unknown>) => {
    try {
      readResult(JSON.stringify(e));
    } catch (err) {
      return [(err as ProviderError).errorClass, (err as ProviderError).message];
    }
    return null;
  };

  it('falls back to the subtype, then a generic message, and classifies overflow and refusals', () => {
    expect(classOf({ subtype: 'error_max_turns' })).toEqual(['transient', 'error_max_turns']);
    expect(classOf({ is_error: true })).toEqual(['transient', 'claude -p failed']);
    expect(classOf({ is_error: true, result: 'Prompt is too long' })[0]).toBe('overflow');
    expect(classOf({ is_error: true, result: 'The model refused' })[0]).toBe('permanent');
    expect(classOf({ is_error: true, result: 'x', api_error_status: 403 })[0]).toBe('auth');
  });
});

describe.skipIf(!posix)('runClaude and probeLogin against a stand-in claude', () => {
  const origPath = process.env.PATH;
  let bin = '';

  beforeAll(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-provider-cov-'));
  });
  afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));
  afterEach(() => {
    process.env.PATH = origPath;
  });

  function stand(script: string, mode = 0o755): void {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode });
    fs.chmodSync(path.join(bin, 'claude'), mode);
    process.env.PATH = `${bin}${path.delimiter}${origPath}`;
  }

  const envelope = (out: unknown) =>
    JSON.stringify({ subtype: 'success', is_error: false, structured_output: out }).replace(/'/g, `'\\''`);

  it('is cancelled before spawning when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await errorOf(runClaude('m', 'x', { signal: ac.signal }));
    expect(err.errorClass).toBe('cancelled');
    expect(err.message).toBe('cancelled before claude started');
  });

  it('reports missing when claude is not on the PATH', async () => {
    process.env.PATH = bin + '-nowhere';
    const seen: (number | null)[] = [];
    const err = await errorOf(runClaude('m', 'x', { onSpawn: (pid) => void seen.push(pid) }));
    expect(err.errorClass).toBe('missing');
    // No pid to report, then the (empty) group confirmed gone.
    expect(seen).toEqual([null, null]);
  });

  it('reports a spawn failure other than ENOENT as transient', async () => {
    stand('echo never', 0o644);
    process.env.PATH = bin;
    const err = await errorOf(runClaude('m', 'x'));
    expect(err.errorClass).toBe('transient');
    expect(err.message).toMatch(/EACCES/);
  });

  it('cancels once when onSpawn aborts and then throws', async () => {
    stand('cat >/dev/null\nsleep 5');
    const ac = new AbortController();
    const err = await errorOf(
      runClaude('m', 'x', {
        signal: ac.signal,
        graceMs: 200,
        onSpawn: (pid) => {
          if (pid === null) return;
          ac.abort();
          throw new Error('db locked');
        },
      }),
    );
    // The abort ended it first; the throw's second `end` is a no-op.
    expect(err.errorClass).toBe('cancelled');
    expect(err.message).toBe('memory processing was turned off');
  });

  it('stops reading past maxOutput and ignores what follows', async () => {
    stand('cat >/dev/null\ni=0\nwhile [ $i -lt 400 ]; do printf "%01000d\\n" 0; i=$((i+1)); done');
    const err = await errorOf(runClaude('m', 'x', { maxOutput: 1024, graceMs: 200 }));
    expect(err.errorClass).toBe('malformed');
    expect(err.message).toMatch(/printed more than/);
  });

  it('classifies an empty stdout by its stderr', async () => {
    stand('cat >/dev/null\necho "Invalid API key · Please run /login" >&2\nexit 1');
    const err = await errorOf(runClaude('m', 'x'));
    expect(err.errorClass).toBe('auth');
    expect(err.message).toMatch(/^claude -p: Invalid API key/);
  });

  it('summarises with a prior, keeps a checkpoint only from a turn that ended', async () => {
    const out = {
      observations: [{ title: 'Rotated refresh tokens', type: 'feature', narrative: 'n', facts: [], files: [], tags: [] }],
      checkpoint: { request: 'rotate tokens', investigated: '', learned: '', completed: 'done', next_steps: '' },
    };
    const log = path.join(bin, 'stdin.log');
    stand(`cat > "${log}"\necho '${envelope(out)}'`);
    const s = new ProviderSummarizer({ kind: 'claude-code', model: 'haiku' } as never);
    expect(s.id).toBe('claude-code:haiku');
    expect(await s.summarize({ project: '/p', sessionId: 's', events: [] })).toEqual([]);

    const ended = await s.summarize({
      project: '/p',
      sessionId: 's',
      events: [ev(), ev({ id: 8, kind: 'assistant', body: 'Done.' })],
      prior: 'earlier work',
    });
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ title: 'Rotated refresh tokens', confidence: 0.8, eventIds: [7, 8] });
    expect(ended.checkpoint?.request).toBe('rotate tokens');
    expect(fs.readFileSync(log, 'utf8')).toMatch(/^<session_so_far>\nearlier work\n<\/session_so_far>\n<evidence project="\/p"/);

    const midTurn = await s.summarize({ project: '/p', sessionId: 's', events: [ev()] });
    expect(midTurn.checkpoint).toBeUndefined();
  });

  it('rejects output of the wrong shape as malformed', async () => {
    stand(`cat >/dev/null\necho '${envelope({ observations: [{ title: '' }] })}'`);
    const s = new ProviderSummarizer({ kind: 'claude-code', model: 'haiku' } as never);
    const err = await errorOf(s.summarize({ project: '/p', sessionId: 's', events: [ev()] }));
    expect(err.errorClass).toBe('malformed');
    expect(err.message).toMatch(/failed validation/);
  });

  it('probeLogin reads auth status, and answers unknown on a timeout', async () => {
    stand(`if [ "$1" = "auth" ]; then echo '{"loggedIn": false}'; fi`);
    expect(await probeLogin()).toBe('auth');
    stand(`echo '{"loggedIn": true}'`);
    expect(await probeLogin()).toBe('ok');
    stand('echo "{}"');
    expect(await probeLogin()).toBe('unknown');
    stand('exec sleep 5');
    expect(await probeLogin(100)).toBe('unknown');
  });

  it('probeLogin answers missing when claude is not installed, unknown when it cannot run', async () => {
    process.env.PATH = bin + '-nowhere';
    expect(await probeLogin()).toBe('missing');
    stand('echo never', 0o644);
    process.env.PATH = bin;
    expect(await probeLogin()).toBe('unknown');
  });

  it('an overflow from a descendant that left the group still ends the call', async () => {
    // The grandchild moves to its own session, so the group is already empty
    // when the output limit trips: signalling it finds nobody, and that is fine.
    const marker = path.join(bin, 'detached');
    fs.rmSync(marker, { force: true });
    stand(
      `cat >/dev/null
perl -MPOSIX -e 'POSIX::setsid(); open(my $m, ">", "${marker}"); close $m; select(undef,undef,undef,0.3); $| = 1; print "x" x 4096 for 1..4;' &
while [ ! -f "${marker}" ]; do sleep 0.02; done
exit 0`,
    );
    const err = await errorOf(runClaude('m', 'x', { maxOutput: 1024, graceMs: 200 }));
    expect(err.errorClass).toBe('malformed');
  });
});
