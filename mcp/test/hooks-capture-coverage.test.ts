import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { insertEntry } from '../src/memory/store.js';
import { projectKey } from '../src/store.js';
import { cleanup, tempDbPath } from './helpers.js';

// The built hooks, spawned the way Claude Code runs them, for the edges the
// behaviour suites (`hooks.test.ts`, `memory-*.test.ts`) do not reach.
const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const CAPTURE = path.join(hooksDir, 'capture-tool.js');
const FILE_CONTEXT = path.join(hooksDir, 'file-context.js');
const GATE = path.join(hooksDir, 'pre-tool-gate.js');

let dbFile = '';
let db: DB;
let home = '';
let repo = '';

beforeEach(() => {
  dbFile = tempDbPath('eklavya-hookcap');
  db = openDb(dbFile);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-hookcap-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-hookcap-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function hook(script: string, input: unknown, opts: { env?: Record<string, string>; args?: string[]; raw?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...opts.env };
  delete env.EKLAVYA_SESSION_ID;
  const res = spawnSync(process.execPath, [script, ...(opts.args ?? [])], {
    input: opts.raw ? String(input) : JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
  return { status: res.status, stdout: res.stdout ?? '' };
}

const writeConfig = (raw: Record<string, unknown>) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(raw));

describe('capture-tool: what a result looks like, whatever shape it came in', () => {
  const capture = (tool: string, toolInput: Record<string, unknown> | undefined, response: unknown) =>
    hook(CAPTURE, {
      session_id: 's1',
      cwd: repo,
      hook_event_name: 'PostToolUse',
      tool_name: tool,
      ...(toolInput ? { tool_input: toolInput } : {}),
      tool_response: response,
    });
  const bodyOf = (tool: string) =>
    (db.prepare('SELECT body, files FROM evidence_events WHERE tool = ? ORDER BY id DESC LIMIT 1').get(tool) as
      | { body: string; files: string | null }
      | undefined);

  it('records a string result for a tool with no arguments', () => {
    expect(capture('ToolA', undefined, 'finished cleanly').status).toBe(0);
    expect(bodyOf('ToolA')?.body).toBe('→ finished cleanly');
  });

  it('keeps only the text blocks of a content-block result', () => {
    capture('ToolB', { command: 'ls' }, [{ type: 'image' }, null, { type: 'text', text: 'hello' }]);
    expect(bodyOf('ToolB')?.body).toBe('ls\n→ hello');
  });

  it('reads content, result arrays and filename lists', () => {
    capture('ToolC', { command: 'c' }, { content: 'from content' });
    expect(bodyOf('ToolC')?.body).toBe('c\n→ from content');
    capture('ToolD', { command: 'd' }, { result: [{ text: 'from result' }] });
    expect(bodyOf('ToolD')?.body).toBe('d\n→ from result');
    capture('Glob', { pattern: '*.ts' }, { filenames: ['a.ts', 'b.ts'] });
    expect(bodyOf('Glob')?.body).toBe('pattern=*.ts\n→ a.ts\nb.ts');
  });

  it("keeps an agent's description and prompt, and nothing from an empty result", () => {
    capture('Task', { description: 'Explore auth', prompt: 'Find the refresh flow' }, {});
    expect(bodyOf('Task')?.body).toBe('Explore auth\nFind the refresh flow');
  });

  it("keeps a failure's stderr, or no message when it gave none", () => {
    capture('Bash', { command: 'npm test' }, { success: false, stderr: 'boom' });
    expect(bodyOf('Bash')?.body).toBe('npm test\nboom');
    capture('ToolE', { command: 'e' }, { is_error: true });
    expect(bodyOf('ToolE')?.body).toBe('e\n');
  });

  it('does nothing without a database', () => {
    fs.rmSync(dbFile);
    expect(capture('ToolF', { command: 'f' }, 'x').status).toBe(0);
    expect(fs.existsSync(dbFile)).toBe(false);
  });
});

describe('file-context: the quiet paths', () => {
  let big = '';
  beforeEach(() => {
    big = path.join(repo, 'big.ts');
    fs.writeFileSync(big, 'x'.repeat(4000));
    insertEntry(db, { project: projectKey(repo), title: 'Big file history', files: ['big.ts'], type: null });
  });
  const read = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    hook(FILE_CONTEXT, { session_id: 's1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: toolInput, ...extra }, { env });

  it('says nothing for a missing or non-string path, a missing file, or a missing database', () => {
    expect(read({ file_path: 42 }).stdout).toBe('');
    expect(read({ file_path: '' }).stdout).toBe('');
    expect(read({ file_path: path.join(repo, 'gone.ts') }).stdout).toBe('');
    expect(read({ file_path: big }, {}, { EKLAVYA_DB: path.join(home, 'none.db') }).stdout).toBe('');
  });

  it('says nothing with memory off, or with no session to remember it by', () => {
    writeConfig({ memory: { enabled: false } });
    expect(read({ file_path: big }).stdout).toBe('');
    fs.rmSync(path.join(home, 'config.json'));
    expect(read({ file_path: big }, { session_id: undefined }).stdout).toBe('');
  });

  it("labels an untyped entry a change, and ranks an entry whose file list JSON.parse rejects as broad", () => {
    // SQLite reads JSON5 (a trailing comma); JavaScript's parser does not.
    db.prepare("UPDATE memory_entries SET files = '[\"big.ts\",]'").run();
    const out = JSON.parse(read({ file_path: big }).stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toMatch(/\[#\d+\] \d{4}-\d\d-\d\d change · Big file history/);
  });
});

describe('pre-tool-gate and the run() wrapper', () => {
  const commit = (extra: Record<string, unknown> = {}, opts: Parameters<typeof hook>[2] = {}) =>
    hook(GATE, { session_id: 's1', cwd: repo, hook_event_name: 'PreToolUse', tool_input: { command: 'git commit -m x' }, ...extra }, opts);

  beforeEach(() => writeConfig({ quiz: { enforced: true } }));

  it('lets a commit through without a database, or without a session', () => {
    expect(commit({}, { env: { EKLAVYA_DB: path.join(home, 'none.db') } }).stdout).toBe('');
    expect(commit({ session_id: undefined }).stdout).toBe('');
  });

  it('fails open when the body throws, and counts the failure by hook name', () => {
    db.exec('DROP TABLE gates');
    const res = commit({}, { env: { EKLAVYA_TELEMETRY: '1', DO_NOT_TRACK: '' } });
    expect(res).toEqual({ status: 0, stdout: '' });
    const counted = db.prepare("SELECT name FROM usage_counts WHERE name LIKE 'hook_error:%'").all() as { name: string }[];
    expect(counted.map((r) => r.name)).toEqual(['hook_error:pre-tool-gate']);
  });

  it('takes the hook name from the launcher argument, and skips one that is not a name', () => {
    db.exec('DROP TABLE gates');
    commit({}, { args: ['pre-tool-gate'], env: { EKLAVYA_TELEMETRY: '1', DO_NOT_TRACK: '' } });
    commit({}, { args: ['Not A Name!'], env: { EKLAVYA_TELEMETRY: '1', DO_NOT_TRACK: '' } });
    const n = db.prepare("SELECT SUM(n) AS n FROM usage_counts WHERE name LIKE 'hook_error:%'").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('reads empty stdin and non-object JSON as no input', () => {
    expect(hook(GATE, '', { raw: true })).toEqual({ status: 0, stdout: '' });
    expect(hook(GATE, '42', { raw: true })).toEqual({ status: 0, stdout: '' });
  });
});
