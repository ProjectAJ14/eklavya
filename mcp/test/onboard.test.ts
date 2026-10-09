/**
 * The settings walk (`onboard.ts`), in-process against a fake terminal: a
 * PassThrough that claims to be a TTY stands in for stdin, and a Writable that
 * records everything stands in for stdout. Keys are typed one at a time, each
 * after the previous one has been handled, the way a person types them.
 * `EKLAVYA_HOME` is a temp directory, so the walk never writes a real config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { askOne, onboard } from '../src/onboard.js';

const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', enter: '\r', space: ' ', ctrlC: '\x03', ctrlD: '\x04' };

let home = '';
let savedHome: string | undefined;
let out = '';
let input: PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => unknown };
const real = {
  stdin: Object.getOwnPropertyDescriptor(process, 'stdin')!,
  stdout: Object.getOwnPropertyDescriptor(process, 'stdout')!,
};

/** Swaps in the fake terminal; `tty: false` makes both ends a pipe. */
function terminal(tty = true): void {
  input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => input });
  const output = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    }),
    { isTTY: tty, columns: 100 },
  );
  Object.defineProperty(process, 'stdin', { value: input, configurable: true });
  Object.defineProperty(process, 'stdout', { value: output, configurable: true });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** Types each key after the previous one has been read. */
async function type(...keys: string[]): Promise<void> {
  for (const k of keys) {
    await tick();
    input.write(k);
  }
}

const configFile = () => path.join(home, 'config.json');
const saved = () => JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, unknown>;
const opts = { claudeMem: false, memoryFlag: null, hookScript: '/x/pre-commit', ask: true } as const;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-onboard-'));
  savedHome = process.env.EKLAVYA_HOME;
  process.env.EKLAVYA_HOME = home;
  out = '';
});

afterEach(() => {
  Object.defineProperty(process, 'stdin', real.stdin);
  Object.defineProperty(process, 'stdout', real.stdout);
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the settings walk', () => {
  it('walks every dial on a first install and saves only what changed', async () => {
    terminal();
    const done = onboard(opts);
    await tick();
    input.emit('keypress', undefined, undefined); // a keypress with no key is ignored
    await type(
      KEY.down, KEY.enter, // quiz: on -> enforced
      '3', // focus: learn, by digit
      'rust\r', // its topic
      'k', KEY.space, // cadence: up wraps to end
      'x', KEY.down, KEY.right, // difficulty: a stray letter does nothing, then easy
      '2', // memory: off
    );
    expect(await done).toBeNull();
    expect(saved()).toEqual({
      quiz: { enabled: true, enforced: true },
      focus: 'learn',
      focus_topic: 'rust',
      cadence: 'end',
      difficulty: 'easy',
      memory: { enabled: false },
    });
    expect(out).toContain('— changed');
    expect(out).toContain('gate commits made outside Claude Code too: /x/pre-commit');
    expect(out).toContain(`settings saved to ${configFile()}`);
    // Memory is off, so neither the model step nor the feedback step was asked.
    expect(out).not.toContain('which model writes the memories');
    expect(out).not.toContain('coach one of your prompts');
  });

  it('writes the file after a first walk even when every answer kept the default', async () => {
    terminal();
    const done = onboard(opts);
    // Six dials, then the prompt-feedback step answered off.
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, '2');
    expect(await done).toBeNull();
    expect(saved()).toEqual({});
    expect(out).toContain('settings unchanged');
  });

  it('turns prompt feedback on for a first install that just presses Enter, and says what it sends', async () => {
    terminal();
    const done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter);
    expect(await done).toBeNull();
    // Feedback needs a model, so the provider is written with it, and the
    // summary shows the model that now writes the memories too.
    expect(saved()).toEqual({
      feedback: { enabled: true },
      providers: { observer: { kind: 'anthropic', model: 'claude-haiku-4-5' } },
    });
    expect(out).toContain('coach one of your prompts');
    expect(out).toContain('leaves this machine');
    expect(out).toContain('claude-haiku-4-5');
  });

  it('keeps the model a first install chose when feedback is turned on', async () => {
    terminal();
    const done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, '3', KEY.enter);
    await done;
    expect(saved()).toEqual({
      feedback: { enabled: true },
      providers: { observer: { kind: 'anthropic', model: 'claude-sonnet-5' } },
    });
  });

  it('starts the step on off for an existing install, and turns it on without touching the model', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ providers: { observer: { kind: 'anthropic', model: 'claude-sonnet-5' } } }),
    );
    terminal();
    const done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, '1');
    await done;
    expect(saved()).toEqual({
      providers: { observer: { kind: 'anthropic', model: 'claude-sonnet-5' } },
      feedback: { enabled: true },
    });
  });

  it('turns prompt feedback off again from a re-walk', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ feedback: { enabled: true } }));
    terminal();
    const done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, '2');
    await done;
    expect(saved().feedback).toEqual({ enabled: false });
  });

  it('keeps the old focus when learn gets no topic, and keeps a topic left blank', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ focus: 'learn' }));
    terminal();
    let done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter); // quiz, focus stays learn, empty topic
    await type(KEY.ctrlD); // then leave the walk
    await done;
    expect(saved().focus).toBe('concept');
    expect(out).toContain('learn needs a topic — kept concept');

    fs.writeFileSync(configFile(), JSON.stringify({ focus: 'learn', focus_topic: 'sql' }));
    out = '';
    done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.ctrlD);
    await done;
    expect(saved()).toEqual({ focus: 'learn', focus_topic: 'sql' });
    expect(out).toContain('[sql]');
  });

  it('keeps the current focus when learn is picked from another one and given no topic', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ focus: 'project' }));
    terminal();
    const done = onboard(opts);
    // Ctrl-D at the topic prompt closes it: an empty answer. Then Ctrl-D leaves the walk.
    await type(KEY.enter, '3', KEY.ctrlD, KEY.ctrlD);
    await done;
    expect(out).toContain('learn needs a topic — kept project');
    expect(saved().focus).toBe('project');
  });

  it('asks which model writes the memories once memory is on, and writes the provider', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ quiz: { enabled: false }, memory: { enabled: false, keep: 1 } }));
    terminal();
    const done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, '1', '2', '2');
    expect(await done).toBeNull();
    expect(saved()).toMatchObject({
      memory: { enabled: true, keep: 1 },
      providers: { observer: { kind: 'anthropic', model: 'claude-haiku-4-5' } },
    });
    expect(out).toContain('which model writes the memories');
  });

  it('sets a hand-picked model back to local', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ quiz: { enabled: true, enforced: true }, providers: { observer: { kind: 'anthropic', model: 'my-model' } } }),
    );
    terminal();
    const done = onboard(opts);
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, '1', '2');
    await done;
    expect(saved().providers).toEqual({ observer: null });
  });

  it('asks Claude Mem users who records, and returns their answer', async () => {
    terminal();
    const done = onboard({ ...opts, claudeMem: true });
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter, '1', KEY.enter, '2');
    expect(await done).toBe('eklavya');
    expect(out).toContain('Claude Mem is installed too — only one should record');
  });

  it('skips the recorder question when --memory already answered it', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ memory: { enabled: false } }));
    terminal();
    const done = onboard({ ...opts, claudeMem: true, memoryFlag: 'claude-mem' });
    await type(KEY.enter, KEY.enter, KEY.enter, KEY.enter);
    expect(await done).toBe('claude-mem');
    expect(out).not.toContain('only one should record');
    expect(out).not.toContain('which model writes the memories');
    expect(out).not.toContain('coach one of your prompts');
  });

  it('keeps every unanswered dial on Ctrl-D', async () => {
    terminal();
    const done = onboard(opts);
    await type(KEY.down, KEY.enter, KEY.ctrlD);
    await done;
    expect(saved()).toEqual({ quiz: { enabled: true, enforced: true } });
  });

  it('exits 130 on Ctrl-C, in a list or at the topic prompt', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    terminal();
    void onboard(opts);
    await type(KEY.ctrlC);
    await tick();
    expect(exit).toHaveBeenCalledWith(130);

    exit.mockClear();
    terminal();
    void onboard(opts);
    await type(KEY.enter, '3', KEY.ctrlC);
    await tick();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('rethrows a terminal failure that is not Ctrl-D', async () => {
    terminal();
    input.setRawMode = () => {
      throw new Error('no raw mode');
    };
    await expect(onboard(opts)).rejects.toThrow('no raw mode');
  });
});

describe('without a terminal', () => {
  it('leaves prompt feedback off on a first install nobody could be asked about', async () => {
    terminal(false);
    await onboard(opts);
    expect(fs.existsSync(configFile())).toBe(false);
    expect(out).not.toContain('coach one of your prompts');
  });

  it('lets Claude Mem keep recording on a first install nobody could be asked about', async () => {
    terminal(false);
    expect(await onboard({ ...opts, claudeMem: true })).toBe('claude-mem');
    expect(fs.existsSync(configFile())).toBe(false);
    expect(out).toContain('change them: eklavya install --settings');
  });

  it('decides nothing on a re-install, and says how to pick', async () => {
    fs.writeFileSync(configFile(), JSON.stringify({ focus: 'learn' }));
    terminal(false);
    expect(await onboard({ ...opts, claudeMem: true, ask: false })).toBeNull();
    expect(out).toContain('pick who records: eklavya install --settings');
    expect(out).toContain('no topic');
  });
});

describe('askOne', () => {
  const options = [
    { value: 'a', detail: 'first' },
    { value: 'b', detail: 'second' },
  ];

  it('answers null off a terminal', async () => {
    terminal(false);
    expect(await askOne('k', 'title', 'a', options)).toBeNull();
  });

  it('returns the choice, or null on Ctrl-D', async () => {
    terminal();
    let answer = askOne('k', 'title', 'a', options);
    await type(KEY.down, KEY.enter);
    expect(await answer).toBe('b');
    answer = askOne('k', 'title', 'a', options);
    await type(KEY.ctrlD);
    expect(await answer).toBeNull();
  });

  it('rethrows any other failure', async () => {
    terminal();
    input.setRawMode = () => {
      throw new Error('no raw mode');
    };
    await expect(askOne('k', 'title', 'a', options)).rejects.toThrow('no raw mode');
  });
});
