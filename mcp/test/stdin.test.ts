import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripBom, HOOK_STDIN, STATUSLINE_STDIN } from '../src/stdin.js';
import { openDb } from '../src/db.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(mcpRoot, 'dist', 'hooks', 'session-start.js');

/**
 * Spawn a hook, write `payload`, and deliberately never close stdin.
 *
 * This is the failure the bound exists for. On Windows the host may run a hook
 * through a PowerShell block that swallows the pipe, so `end` never fires --
 * and a read that waits for EOF waits forever, blocking the session on every
 * tool call that triggers the hook.
 */
function hookWithoutEof(payload: string, timeoutMs = 12000) {
  return new Promise<{ code: number | null; stdout: string; timedOut: boolean }>((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-stdin-'));
    // The hook has nothing to say without a database, and `openExisting` is
    // right to return null rather than create one -- so the fixture makes it.
    const dbFile = path.join(home, 'knowledge.db');
    openDb(dbFile).close();

    const child = spawn(process.execPath, [runner], {
      env: { ...process.env, EKLAVYA_HOME: home, EKLAVYA_DB: dbFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    // EPIPE on the write side must not surface as an unhandled stream error.
    child.stdin.on('error', () => {});
    child.stdin.write(payload);
    // No child.stdin.end() -- that is the whole point.

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, timedOut: true });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(killer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, timedOut: false });
    });
  });
}

describe('a hook whose stdin never ends', () => {
  it('still exits, and exits 0', async () => {
    const res = await hookWithoutEof(JSON.stringify({ session_id: 'no-eof', cwd: mcpRoot }));
    expect(res.timedOut, 'the hook hung — this is the bug the bound exists for').toBe(false);
    expect(res.code).toBe(0);
  }, 20000);

  it('still does its work, rather than degrading to an empty input', async () => {
    // The bound is on silence, not on total time. The payload arrived; only the
    // EOF never did, so the hook should behave exactly as it always does.
    const res = await hookWithoutEof(JSON.stringify({ session_id: 'no-eof-2', cwd: mcpRoot }));
    expect(res.stdout).toContain('[Eklavya]');
  }, 20000);

  it('survives a byte-order mark, which some Windows shells prepend', async () => {
    // JSON.parse throws on input that looks perfectly well-formed everywhere
    // else, and a hook that cannot parse its input silently does nothing.
    const res = await hookWithoutEof(`﻿${JSON.stringify({ session_id: 'bom', cwd: mcpRoot })}`);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[Eklavya]');
  }, 20000);
});

describe('a caller with no process.exit behind it', () => {
  /**
   * `eklavya statusline`, spawned with a payload and no EOF.
   *
   * The hooks hide this failure: `run()` ends in `process.exit`, so the process
   * goes away whatever the stream is doing. The statusline just returns, so it
   * is the honest test of whether the read actually lets go -- and it did not.
   * Removing the `data` listener leaves the stream flowing, and a flowing stdin
   * holds a libuv handle open, so the bar printed its line at 300ms and then
   * sat there forever, once per refresh.
   */
  function statuslineWithoutEof(timeoutMs = 4000) {
    return new Promise<{ exited: boolean; printed: boolean; ms: number }>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [path.join(mcpRoot, 'dist', 'cli.js'), 'statusline'], {
        cwd: mcpRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let printed = false;
      child.stdout.on('data', () => (printed = true));
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ cwd: mcpRoot }));
      // Never child.stdin.end().

      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ exited: false, printed, ms: Date.now() - started });
      }, timeoutMs);
      child.on('close', () => {
        clearTimeout(killer);
        resolve({ exited: true, printed, ms: Date.now() - started });
      });
    });
  }

  it('exits, rather than printing and lingering forever', async () => {
    const res = await statuslineWithoutEof();
    expect(res.printed).toBe(true);
    expect(res.exited, 'the process printed and then never exited').toBe(true);
  }, 12000);

  it('exits fast enough that a status bar refresh does not stack up', async () => {
    // A bar that leaves a process behind on every refresh is a slow leak; one
    // that takes a second to answer is a visible stutter.
    const res = await statuslineWithoutEof();
    expect(res.ms).toBeLessThan(STATUSLINE_STDIN.totalMs + 900);
  }, 12000);
});

describe('the bounds themselves', () => {
  it('sits well under the smallest timeout hooks.json grants', () => {
    // 10s for four hooks, 15s for Stop. A read that outlives its host timeout
    // is a read the developer waits on, so both bounds must clear it with room.
    const hooks = JSON.parse(
      fs.readFileSync(path.join(path.dirname(mcpRoot), 'hooks', 'hooks.json'), 'utf8'),
    );
    const timeouts: number[] = [];
    for (const entries of Object.values(hooks.hooks as Record<string, unknown[]>)) {
      for (const entry of entries as { hooks: { timeout?: number }[] }[]) {
        for (const h of entry.hooks) if (h.timeout) timeouts.push(h.timeout);
      }
    }
    expect(timeouts.length).toBeGreaterThan(0);
    expect(HOOK_STDIN.totalMs).toBeLessThan(Math.min(...timeouts) * 1000);
  });

  it('gives the status bar a smaller budget than a hook', () => {
    // A bar blocks on every refresh; a hook blocks once per trigger.
    expect(STATUSLINE_STDIN.totalMs).toBeLessThan(HOOK_STDIN.totalMs);
    expect(STATUSLINE_STDIN.idleMs).toBeLessThan(HOOK_STDIN.idleMs);
  });

  it('never makes the status bar slower than the flat cap it replaced', () => {
    // The inline reader this replaced was a flat 250ms. Splitting that into
    // idle + total quietly made the worst case 1000ms -- four times worse, for
    // the one caller whose latency a human sees, in a change whose whole point
    // was that it should not be felt.
    expect(STATUSLINE_STDIN.totalMs).toBeLessThanOrEqual(250);
  });

  it('bounds silence, not total time, so a slow payload is not truncated', () => {
    // A flat cap cuts a still-arriving payload into invalid JSON, and truncated
    // JSON does not fail loudly -- it fails as {}, and the hook runs to
    // completion having decided the session has no cwd and no id.
    expect(HOOK_STDIN.idleMs).toBeLessThan(HOOK_STDIN.totalMs);
  });
});

describe('stripBom', () => {
  it('removes a leading byte-order mark and nothing else', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
    // Only leading: a BOM mid-string is content, not an encoding artefact.
    expect(stripBom('{"a":"﻿"}')).toBe('{"a":"﻿"}');
  });
});
