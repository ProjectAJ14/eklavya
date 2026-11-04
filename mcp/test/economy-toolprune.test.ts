import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { applyDeny, isProtected, measure, propose, restoreDeny, settingsPath } from '../src/economy/toolprune.js';
import { applyProposal, evidence, kept, measureProposal, proposal, recordToolUse, restoreNewlyProtected, restoreTools, writeRecord } from '../src/toolprune-store.js';
import { openSession } from '../src/ledger-pending.js';

const config = (patch: (c: EklavyaConfig) => void = () => {}): EklavyaConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return c;
};

let root: string;
let repo: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-prune-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const settings = () => path.join(repo, '.claude', 'settings.local.json');
const write = (text: string) => {
  fs.mkdirSync(path.dirname(settings()), { recursive: true });
  fs.writeFileSync(settings(), text);
};

describe('the proposal rule', () => {
  it('never proposes a protected tool, and needs prompts across sessions or many sessions', () => {
    expect(isProtected('Bash')).toBe(true);
    expect(isProtected('mcp__plugin_eklavya_eklavya__memory_get')).toBe(true);
    expect(isProtected('CronCreate', ['CronCreate'])).toBe(true);
    expect(isProtected('CronCreate')).toBe(false);
    const rule = { evidence: 10, min_sessions: 2, sessions: 5, protect: [] };
    expect(
      propose(
        [
          { tool: 'Read', prompts_since: 99, sessions_since: 99 },
          { tool: 'A', prompts_since: 10, sessions_since: 2 },
          { tool: 'B', prompts_since: 10, sessions_since: 1 },
          { tool: 'C', prompts_since: 0, sessions_since: 5 },
          { tool: 'D', prompts_since: 12, sessions_since: 2 },
        ],
        rule,
      ).map((r) => r.tool),
    ).toEqual(['C', 'D', 'A']);
  });

  it('measures deferred tools by their listing line', () => {
    expect(measure({ X: 100, Y: 50 }, ['Z'], ['X', 'Z'])).toEqual({ before: 162, after: 50, saved: 112 });
  });
});

// The gate (#263): apply then restore leaves the file byte-identical, on twenty
// shapes of settings file, including the developer's own deny rules.
const FIXTURES: (string | null)[] = [
  null,
  '{}',
  '{}\n',
  '{\n  "permissions": {}\n}\n',
  '{\n  "permissions": {\n    "deny": []\n  }\n}\n',
  '{\n  "permissions": {\n    "deny": ["Bash(rm:*)"]\n  }\n}\n',
  '{\n    "permissions": {\n        "allow": ["Read"],\n        "deny": ["WebFetch"]\n    }\n}\n',
  '{\n\t"permissions": {\n\t\t"deny": ["CronCreate"]\n\t}\n}',
  '{"permissions":{"deny":["X"]},"env":{"A":"1"}}',
  '{\n  "env": { "A": "1" }\n}\n',
  '{\n  "model": "opus",\n  "permissions": { "ask": ["Bash"] }\n}\n',
  '{ "permissions": { "deny": ["CronCreate", "Bash(curl:*)"] } }\n',
  '{\n  "hooks": {},\n  "permissions": { "defaultMode": "plan" }\n}',
  '  {"permissions": {"deny": []}}  \n',
  '{\n  "permissions": {\n    "deny": [\n      "Read(./.env)"\n    ]\n  },\n  "statusLine": {"type": "command"}\n}\n',
  '{"a":[1,2,3],"b":{"c":null}}',
  '{\n  "permissions": {\n    "deny": ["Monitor"],\n    "allow": []\n  }\n}\n',
  '{\r\n  "permissions": {}\r\n}\r\n',
  '{\n  "enabledPlugins": {"x@y": true}\n}\n',
  '{\n  "permissions": {\n    "additionalDirectories": ["../shared"]\n  }\n}\n',
];

describe('apply then restore', () => {
  it.each(FIXTURES.map((f, i) => [i, f] as const))('leaves fixture %i byte-identical', (_i, text) => {
    if (text !== null) write(text);
    const r = applyDeny(repo, ['CronCreate', 'Monitor', 'DesignSync']);
    expect(r.ok).toBe(true);
    const denied = JSON.parse(fs.readFileSync(settings(), 'utf8')).permissions.deny as string[];
    expect(denied).toEqual(expect.arrayContaining(['CronCreate', 'Monitor', 'DesignSync']));
    expect(restoreDeny(repo, (r as { record: never }).record)).toMatchObject({ ok: true });
    if (text === null) expect(fs.existsSync(settings())).toBe(false);
    else expect(fs.readFileSync(settings(), 'utf8')).toBe(text);
  });

  it('adds the file it creates to .git/info/exclude, and takes the line out again', () => {
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '# local\n*.log');
    const r = applyDeny(repo, ['CronCreate']);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('# local\n*.log\n/.claude/settings.local.json\n');
    restoreDeny(repo, (r as { record: never }).record);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe('# local\n*.log\n');
  });

  it('keeps a developer\'s later edits, removing only Eklavya\'s entries', () => {
    write('{\n  "permissions": {\n    "deny": ["Mine"]\n  }\n}\n');
    const r = applyDeny(repo, ['CronCreate', 'Mine']);
    const json = JSON.parse(fs.readFileSync(settings(), 'utf8'));
    json.env = { B: '2' };
    fs.writeFileSync(settings(), JSON.stringify(json, null, 2));
    expect(restoreDeny(repo, (r as { record: never }).record)).toEqual({ ok: true, removed: ['CronCreate'] });
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8'))).toEqual({ permissions: { deny: ['Mine'] }, env: { B: '2' } });
  });

  it('refuses invalid JSON, odd shapes and a .claude that leads out of the checkout', () => {
    write('{ nope');
    expect(applyDeny(repo, ['X'])).toEqual({ ok: false, reason: 'settings.local.json is not valid JSON' });
    write('[]');
    expect(applyDeny(repo, ['X'])).toMatchObject({ ok: false, reason: expect.stringContaining('not a JSON object') });
    write('{"permissions": 3}');
    expect(applyDeny(repo, ['X'])).toMatchObject({ ok: false, reason: expect.stringContaining('permissions value') });
    write('{"permissions": {"deny": "X"}}');
    expect(applyDeny(repo, ['X'])).toMatchObject({ ok: false, reason: expect.stringContaining('permissions.deny') });
    expect(restoreDeny(repo, { file: settings(), original: null, added: ['X'], excludeLine: null })).toMatchObject({ ok: false });
    fs.rmSync(path.join(repo, '.claude'), { recursive: true });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, '.claude'));
    expect(applyDeny(repo, ['X'])).toMatchObject({ ok: false, reason: expect.stringContaining('.claude is a symlink') });
    fs.rmSync(path.join(repo, '.claude'));
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(outside, 's.json'), '{}');
    fs.symlinkSync(path.join(outside, 's.json'), settings());
    expect(settingsPath(repo)).toMatchObject({ reason: expect.stringContaining('settings.local.json is a symlink') });
  });

  it('adds nothing already denied, keeps a first record\'s original on a second apply, and restores one tool alone', () => {
    write('{"permissions": {"deny": ["A"]}}');
    const first = applyDeny(repo, ['A']);
    expect(first).toMatchObject({ ok: true, record: { added: [] } });
    const second = applyDeny(repo, ['B'], (first as { record: never }).record);
    const third = applyDeny(repo, ['C'], (second as { record: never }).record) as { record: { added: string[]; original: string } };
    expect(third.record).toMatchObject({ added: ['B', 'C'], original: '{"permissions": {"deny": ["A"]}}' });
    expect(restoreDeny(repo, third.record as never, ['B'])).toEqual({ ok: true, removed: ['B'] });
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8')).permissions.deny).toEqual(['A', 'C']);
    // Nothing to remove and nothing to write.
    expect(restoreDeny(repo, { ...third.record, added: ['Z'] } as never)).toEqual({ ok: true, removed: [] });
  });

  it('skips the exclude file outside a real git directory or when the line is there', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere');
    expect((applyDeny(repo, ['X']) as { record: { excludeLine: string | null } }).record.excludeLine).toBeNull();
    fs.rmSync(settings());
    fs.rmSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.claude/settings.local.json\n');
    expect((applyDeny(repo, ['X']) as { record: { excludeLine: string | null } }).record.excludeLine).toBeNull();
    fs.rmSync(settings());
    fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true });
    const r = (applyDeny(repo, ['X']) as { record: never }).record;
    fs.rmSync(path.join(repo, '.git', 'info', 'exclude'));
    expect(restoreDeny(repo, r)).toMatchObject({ ok: true });
    const again = (applyDeny(repo, ['X']) as { record: never }).record;
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'other\n');
    expect(restoreDeny(repo, again)).toMatchObject({ ok: true });
  });
});

describe('the store', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(path.join(root, 'knowledge.db'));
  });
  afterEach(() => db.close());

  const session = (id: string, used: Record<string, number>, prompts = 6) => {
    openSession(db, { sessionId: id, project: repo, transcriptPath: null });
    recordToolUse(db, repo, id, { tools: used, deferredTools: ['CronCreate', 'Monitor', 'mcp__x__y'], prompts });
  };

  it('ages unused tools per session, resets a used one, and counts a session once', () => {
    session('a', { Bash: 3 });
    session('a', { Bash: 3 });
    session('b', { Bash: 1, Monitor: 1 });
    const rows = Object.fromEntries(evidence(db, repo).map((r) => [r.tool, r]));
    expect(rows.CronCreate).toMatchObject({ prompts_since: 12, sessions_since: 2, deferred: 1 });
    expect(rows.Monitor).toMatchObject({ prompts_since: 0, sessions_since: 0 });
    expect(rows.Bash).toMatchObject({ prompts_since: 0, deferred: 0 });
  });

  it('proposes, applies, restores and keeps restored tools out of the proposal', () => {
    session('a', {});
    session('b', {});
    expect(proposal(db, config(), repo).map((r) => r.tool)).toEqual(['CronCreate', 'mcp__x__y', 'Monitor']);
    expect(measureProposal(db, config(), repo)).toEqual({ tools: 3, deferred: 3, listingTokens: 36 });
    expect(applyProposal(db, config((c) => (c.economy.toolprune = 'off')), repo, repo)).toEqual({ ok: false, reason: 'economy.toolprune is off' });
    expect(applyProposal(db, config(), repo, repo, ['Monitor'])).toEqual({ ok: true, tools: ['Monitor'] });
    expect(applyProposal(db, config(), repo, repo)).toEqual({ ok: true, tools: ['CronCreate', 'mcp__x__y'] });
    expect(applyProposal(db, config(), repo, repo)).toEqual({ ok: true, tools: [] });
    expect(writeRecord(db, repo)!.added).toEqual(['Monitor', 'CronCreate', 'mcp__x__y']);
    expect(restoreTools(db, repo, repo, ['Monitor'])).toEqual({ ok: true, tools: ['Monitor'] });
    expect(kept(db, repo)).toEqual(['Monitor']);
    expect(proposal(db, config(), repo)).toEqual([]);
    // A tool that has since become protected comes back without being kept.
    expect(restoreNewlyProtected(db, config((c) => (c.economy.toolprune_protect = ['CronCreate'])), repo, repo)).toEqual(['CronCreate']);
    expect(kept(db, repo)).toEqual(['Monitor']);
    expect(restoreNewlyProtected(db, config(), repo, repo)).toEqual([]);
    expect(restoreTools(db, repo, repo)).toEqual({ ok: true, tools: ['mcp__x__y'] });
    expect(writeRecord(db, repo)).toBeNull();
    expect(restoreTools(db, repo, repo)).toEqual({ ok: true, tools: [] });
    expect(fs.existsSync(settings())).toBe(false);
  });

  it('reports a refusal from the file', () => {
    session('a', {});
    session('b', {});
    write('{ broken');
    expect(applyProposal(db, config(), repo, repo)).toMatchObject({ ok: false });
    db.prepare('INSERT INTO econ_settings_writes (project, record, applied_at) VALUES (?, ?, ?)').run(
      repo,
      JSON.stringify({ file: settings(), original: null, added: ['CronCreate'], excludeLine: null }),
      'x',
    );
    expect(restoreTools(db, repo, repo)).toMatchObject({ ok: false });
    expect(restoreNewlyProtected(db, config((c) => (c.economy.toolprune_protect = ['CronCreate'])), repo, repo)).toEqual([]);
  });
});
