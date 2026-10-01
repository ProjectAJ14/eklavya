import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, heading, padEndVisible, spin, verdict, visibleWidth } from '../src/theme.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const themeUrl = pathToFileURL(path.join(mcpRoot, 'dist', 'theme.js')).href;

function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm' };
  for (const k of ['NO_COLOR', 'FORCE_COLOR', 'COLORTERM']) delete out[k];
  return { ...out, ...env };
}

/**
 * `useColor` and the colour depth are read once, at import, from the
 * environment -- so each combination is its own process.
 */
function render(env: Record<string, string>): string {
  const script = `const t = await import(${JSON.stringify(themeUrl)});
    process.stdout.write(JSON.stringify([t.useColor, t.paint.ok('x'), t.bold('b'), t.dim('d')]));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: childEnv(env),
  });
  expect(res.status).toBe(0);
  return res.stdout;
}

describe('terminal colour', () => {
  it('prints plain text through a pipe, under NO_COLOR and on a dumb terminal', () => {
    for (const env of [{}, { NO_COLOR: '1', FORCE_COLOR: '1' }, { TERM: 'dumb', FORCE_COLOR: '1' }]) {
      expect(JSON.parse(render(env))).toEqual([false, 'x', 'b', 'd']);
    }
  });

  it('uses 24-bit colour only when COLORTERM says the terminal has it', () => {
    expect(JSON.parse(render({ FORCE_COLOR: '1', COLORTERM: 'truecolor' }))).toEqual([
      true,
      '\x1b[38;2;121;213;196mx\x1b[39m',
      '\x1b[1mb\x1b[22m',
      '\x1b[2md\x1b[22m',
    ]);
  });

  it('falls back to the basic 16 colours otherwise', () => {
    expect(JSON.parse(render({ FORCE_COLOR: '1' }))[1]).toBe('\x1b[96mx\x1b[39m');
  });
});

describe('terminal rows', () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  afterEach(() => {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    vi.restoreAllMocks();
  });

  function captured(): string[] {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    });
    return out;
  }

  it('measures width without escapes', () => {
    expect(visibleWidth('\x1b[96m▣\x1b[39m ok')).toBe(4);
    expect(padEndVisible('\x1b[1mab\x1b[22m', 4)).toBe('\x1b[1mab\x1b[22m  ');
  });

  it('prints a continuation row without a glyph, and a closing verdict', () => {
    const out = captured();
    check(null, '', 'more');
    check('warn', 'gate', 'detail');
    verdict('broken', 'fine');
    verdict(null, 'fine');
    heading('eklavya doctor');
    expect(out).toEqual(['                 more\n', '  !  gate        detail\n', '\n', '▤ broken\n', '\n', '▣ fine\n', '\neklavya doctor\n\n']);
  });

  it('animates on a TTY and clears its row when the work is done', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const out = captured();
    expect(await spin('import', 'importing…', async () => 42)).toBe(42);
    expect(out[0]).toMatch(/^\r\x1b\[2K {2}⠋ {2}import {6}importing…$/);
    expect(out.at(-1)).toBe('\r\x1b[2K');
  });

  it('clears the row even when the work fails', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const out = captured();
    await expect(spin('import', 'x', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(out.at(-1)).toBe('\r\x1b[2K');
  });

  it('prints the label once off a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const out = captured();
    expect(await spin('import', 'importing…', async () => 'done')).toBe('done');
    expect(out).toEqual(['  ·  import      importing…\n']);
  });
});
