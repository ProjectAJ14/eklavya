import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  activeClaudeMemPluginIds,
  claudeMemDir,
  claudeMemPluginIds,
  guessProjectMap,
  removeClaudeMemPlugin,
  retireClaudeMemDir,
} from '../src/claude-mem.js';
import { PROJECT, buildSource } from './claude-mem-fixture.js';

/**
 * The fixture's one session is `content-1` in `demo-repo`. Claude Code keeps its
 * transcript in a directory named after the checkout, and that transcript
 * records the cwd -- which is what places the project.
 */
let tmp = '';
let claudeHome = '';
let source = '';
let checkout = '';

const transcriptDir = (dir: string) => path.join(claudeHome, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cmem-map-')));
  claudeHome = path.join(tmp, 'claude');
  source = path.join(tmp, 'claude-mem.db');
  buildSource(source);
  checkout = path.join(tmp, 'work', 'demo_repo');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function transcript(dir: string, cwd: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content-1.jsonl'), `${JSON.stringify({ type: 'user', cwd })}\n`);
}

describe('guessProjectMap', () => {
  it('places a project where its sessions ran', () => {
    transcript(transcriptDir(checkout), path.join(checkout, 'src'));
    expect(guessProjectMap(source, claudeHome)).toEqual({ [PROJECT]: checkout });
  });

  it('follows a checkout that moved: the transcript dir is renamed, the recorded cwd is not', () => {
    // `demo_repo` encodes to `demo-repo` -- lossy, so this also pins the walk.
    transcript(transcriptDir(checkout), path.join(tmp, 'old-place', 'demo_repo'));
    expect(guessProjectMap(source, claudeHome)).toEqual({ [PROJECT]: checkout });
  });

  it('leaves out a project it cannot place, rather than guess', () => {
    transcript(transcriptDir(path.join(tmp, 'gone')), path.join(tmp, 'gone'));
    expect(guessProjectMap(source, claudeHome)).toEqual({});
  });

  it('finds a checkout moved outside Claude Code: old path and transcript dir both gone', () => {
    // ~/Workspace/Personal/<p> copied to ~/Workspace/local/<p> on a new machine.
    const moved = path.join(tmp, 'work', 'local', PROJECT);
    fs.mkdirSync(path.join(moved, '.git'), { recursive: true });
    transcript(transcriptDir(path.join(tmp, 'work', 'Personal', PROJECT)), path.join(tmp, 'work', 'Personal', PROJECT));
    expect(guessProjectMap(source, claudeHome)).toEqual({ [PROJECT]: moved });
  });

  it('names both candidates rather than pick one when two checkouts carry the name', () => {
    const a = path.join(tmp, 'work', 'local', PROJECT);
    const b = path.join(tmp, 'work', 'other', PROJECT);
    for (const d of [a, b]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    transcript(transcriptDir(path.join(tmp, 'work', 'Personal', PROJECT)), path.join(tmp, 'work', 'Personal', PROJECT));
    const unsure: Record<string, string[]> = {};
    expect(guessProjectMap(source, claudeHome, unsure)).toEqual({});
    expect(unsure).toEqual({ [PROJECT]: [a, b] });
  });

  it('votes past everything it cannot read, and places by name or folder when no session can', () => {
    const projects = path.join(claudeHome, 'projects');
    const plain = path.join(tmp, 'plain'); // exists, but is no checkout
    fs.mkdirSync(plain);
    const lonely = path.join(tmp, 'work', 'lonely');
    fs.mkdirSync(path.join(lonely, '.git'), { recursive: true });
    const afile = path.join(tmp, 'afile');
    fs.writeFileSync(afile, '');

    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 'stray-file'), '');
    // No transcripts at all, and a name that walks into a file: nothing to place it by.
    fs.mkdirSync(transcriptDir(path.join(afile, 'x')));
    // Unreadable transcripts: a dangling link and a directory, beside one with no cwd.
    const odd = transcriptDir(path.join(tmp, 'odd'));
    fs.mkdirSync(path.join(odd, 'as-dir.jsonl'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(odd, 'dangling.jsonl'));
    fs.writeFileSync(path.join(odd, 'no-cwd.jsonl'), '{"type":"user"}\n');
    // A session whose cwd is no checkout, in a folder that decodes to one.
    fs.mkdirSync(transcriptDir(checkout));
    fs.writeFileSync(path.join(transcriptDir(checkout), 'plain-cwd.jsonl'), `${JSON.stringify({ cwd: plain })}\n`);
    // The same cwd where the folder name decodes to nothing.
    fs.mkdirSync(transcriptDir(path.join(tmp, 'nothing-here')));
    fs.writeFileSync(path.join(transcriptDir(path.join(tmp, 'nothing-here')), 'lost-cwd.jsonl'), `${JSON.stringify({ cwd: plain })}\n`);
    // `lonely`'s only transcript belongs to no Claude Mem session.
    transcript(transcriptDir(lonely), lonely);

    const custom = path.join(tmp, 'custom.db');
    const db = new Database(custom);
    db.exec('CREATE TABLE sdk_sessions (project TEXT, content_session_id TEXT)');
    const add = db.prepare('INSERT INTO sdk_sessions VALUES (?, ?)');
    for (const [p, id] of [
      ['ghost', null],
      ['unknown', 'no-such-transcript'],
      ['odd', 'as-dir'],
      ['odd', 'dangling'],
      ['odd', 'no-cwd'],
      ['by-folder', 'plain-cwd'],
      ['nowhere', 'lost-cwd'],
      ['lonely', 'no-such-session'],
    ]) add.run(p, id);
    db.close();

    expect(guessProjectMap(custom, claudeHome)).toEqual({ 'by-folder': checkout, lonely });
  });

  it('never proposes a folder it cannot open, a hidden one, or one inside another checkout', () => {
    const work = path.join(tmp, 'work2');
    const inner = path.join(work, 'repo', PROJECT); // named right, but part of `repo`
    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(path.join(work, 'repo', '.git'));
    fs.mkdirSync(path.join(work, 'repo', 'other'));
    for (const d of ['.hidden', 'node_modules']) fs.mkdirSync(path.join(work, d, PROJECT, '.git'), { recursive: true });
    fs.writeFileSync(path.join(work, 'file'), '');
    const locked = path.join(work, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0);
    const lost = path.join(work, 'Personal', PROJECT);
    transcript(transcriptDir(lost), lost);
    const unsure: Record<string, string[]> = {};
    try {
      expect(guessProjectMap(source, claudeHome, unsure)).toEqual({});
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    expect(unsure).toEqual({});
  });
});

describe('the Claude Mem plugin', () => {
  it('lists every Claude Mem id from both registries, and treats only a switched-off one as inactive', () => {
    expect(claudeMemPluginIds(claudeHome)).toEqual([]);
    expect(activeClaudeMemPluginIds(claudeHome)).toEqual([]);
    fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'claude-mem@a': {}, 'other@x': {} } }),
    );
    fs.writeFileSync(
      path.join(claudeHome, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'claude-mem@a': true, 'claude-mem@b': false } }),
    );
    expect(claudeMemPluginIds(claudeHome)).toEqual(['claude-mem@a', 'claude-mem@b']);
    expect(activeClaudeMemPluginIds(claudeHome)).toEqual(['claude-mem@a']);
  });

  it('keeps its data under ~/.claude-mem unless CLAUDE_MEM_DATA_DIR says otherwise', () => {
    const saved = process.env.CLAUDE_MEM_DATA_DIR;
    delete process.env.CLAUDE_MEM_DATA_DIR;
    try {
      expect(claudeMemDir()).toBe(path.join(os.homedir(), '.claude-mem'));
    } finally {
      if (saved !== undefined) process.env.CLAUDE_MEM_DATA_DIR = saved;
    }
  });

  it('retires the data folder beside itself, never over an earlier retirement', () => {
    const saved = process.env.CLAUDE_MEM_DATA_DIR;
    const dir = path.join(tmp, 'mem');
    process.env.CLAUDE_MEM_DATA_DIR = dir;
    try {
      fs.mkdirSync(dir);
      fs.mkdirSync(`${dir}.retired`);
      expect(retireClaudeMemDir()).toBe(`${dir}.retired-2`);
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = saved;
    }
  });

  describe.skipIf(process.platform === 'win32')('removal', () => {
    let savedPath: string | undefined;
    let bin = '';
    beforeEach(() => {
      savedPath = process.env.PATH;
      bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      process.env.PATH = bin;
    });
    afterEach(() => {
      process.env.PATH = savedPath;
    });
    const fakeClaude = (code: number) => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });

    it("uninstalls through Claude Code's CLI when it can", async () => {
      fakeClaude(0);
      expect(await removeClaudeMemPlugin(claudeHome, ['claude-mem@a'])).toEqual({ how: 'uninstalled', backup: null });
      expect(fs.existsSync(path.join(claudeHome, 'settings.json'))).toBe(false);
    });

    it('switches the plugin off in settings.json when the CLI fails or is missing', async () => {
      fakeClaude(1);
      expect(await removeClaudeMemPlugin(claudeHome, ['claude-mem@a'])).toEqual({ how: 'disabled', backup: null });
      const settings = path.join(claudeHome, 'settings.json');
      expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ enabledPlugins: { 'claude-mem@a': false } });

      fs.rmSync(path.join(bin, 'claude'));
      const res = await removeClaudeMemPlugin(claudeHome, ['claude-mem@b']);
      expect(res).toEqual({ how: 'disabled', backup: `${settings}.eklavya-bak` });
      expect(JSON.parse(fs.readFileSync(settings, 'utf8')).enabledPlugins).toEqual({
        'claude-mem@a': false,
        'claude-mem@b': false,
      });
    });
  });
});
