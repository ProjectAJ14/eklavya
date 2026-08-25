import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { conceptBySlug, gradeConcept, logSessionConcept, syncGate } from '../src/store.js';
import { tempDbPath, cleanup } from './helpers.js';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PRE_TOOL_GATE = path.join(root, 'hooks', 'pre-tool-gate.sh');
const GATE_CLI = path.join(root, 'cli', 'eklavya-gate');
const INSTALLER = path.join(root, 'scripts', 'install-git-hook.sh');

const SESSION = 'gate-session';

let dbFile = '';
let db: DB;
let home = '';
let repo = '';

function sh(cmd: string, args: string[], opts: { input?: string; cwd?: string; env?: Record<string, string> } = {}) {
  const res = spawnSync(cmd, args, {
    input: opts.input,
    cwd: opts.cwd,
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...(opts.env ?? {}) },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const preToolGate = (command: string, extra: Record<string, unknown> = {}) =>
  sh('/bin/sh', [PRE_TOOL_GATE], {
    input: JSON.stringify({
      session_id: SESSION,
      cwd: repo,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      ...extra,
    }),
  });

const gateCli = (cwd = repo) => sh('/bin/sh', [GATE_CLI], { cwd });

function repoConfig(patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, '.eklavya.json'), JSON.stringify(patch));
}

function openGate(opts: { required: number; answeredWell?: number }): void {
  const slugs = ['csrf', 'jwt-structure', 'pkce', 'rbac'].slice(0, opts.required);
  for (const slug of slugs) {
    logSessionConcept(db, SESSION, conceptBySlug(db, slug)!.id, `touched ${slug}`);
  }
  for (const slug of slugs.slice(0, opts.answeredWell ?? 0)) {
    gradeConcept(db, {
      conceptId: conceptBySlug(db, slug)!.id,
      sessionId: SESSION,
      question: 'q',
      answer: 'a',
      grade: 5,
      difficulty: 2,
      feedback: null,
      now: new Date(),
    });
  }
  const { config, repoRoot } = loadConfig(repo);
  syncGate(db, SESSION, config, { requiredHint: opts.required, repo: repoRoot });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  dbFile = tempDbPath('gate');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('PreToolUse gate — getting out of the way', () => {
  it.each([
    'npm test',
    'ls -la',
    'git status',
    'git log --oneline',
    'git add .',
  ])('ignores %s', (cmd) => {
    repoConfig({ mode: 'enforced' });
    openGate({ required: 2 });
    expect(preToolGate(cmd).stdout).toBe('');
  });

  it('does not block a command that merely mentions committing', () => {
    repoConfig({ mode: 'enforced' });
    openGate({ required: 2 });
    expect(preToolGate('echo "git commit -m hi"').stdout).toBe('');
  });

  it('says nothing in ambient mode', () => {
    repoConfig({ mode: 'ambient' });
    openGate({ required: 2 });
    expect(preToolGate('git commit -m "wip"').stdout).toBe('');
  });

  it('says nothing when there is no gate for the session', () => {
    repoConfig({ mode: 'enforced' });
    expect(preToolGate('git commit -m "wip"').stdout).toBe('');
  });

  it('is fast enough to sit on every Bash call', () => {
    repoConfig({ mode: 'enforced' });
    openGate({ required: 2 });
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) preToolGate('npm run build');
    expect((Date.now() - started) / 5).toBeLessThan(150);
  });
});

describe('PreToolUse gate — holding a commit', () => {
  beforeEach(() => {
    repoConfig({ mode: 'enforced', pass_threshold: 1 });
  });

  it('denies the commit with an instructive reason', () => {
    openGate({ required: 2 });
    const res = preToolGate('git commit -m "add auth"');
    expect(res.status).toBe(0);

    const payload = JSON.parse(res.stdout);
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(payload.hookSpecificOutput.permissionDecisionReason).toMatch(/0 of 2 concepts/);
    expect(payload.hookSpecificOutput.permissionDecisionReason).toMatch(/get_session_quiz_plan/);
  });

  it.each([
    'git commit -am "x"',
    'npm test && git commit -m "x"',
    'sudo git commit -m "x"',
    'git -C . commit -m "x"',
  ])('catches %s', (cmd) => {
    openGate({ required: 2 });
    expect(JSON.parse(preToolGate(cmd).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('lets the commit through once the quiz passes', () => {
    openGate({ required: 2, answeredWell: 2 });
    expect(preToolGate('git commit -m "add auth"').stdout).toBe('');
  });

  it('still holds when the answers were skips', () => {
    openGate({ required: 2 });
    for (const slug of ['csrf', 'jwt-structure']) {
      gradeConcept(db, {
        conceptId: conceptBySlug(db, slug)!.id,
        sessionId: SESSION,
        question: 'q',
        answer: null,
        grade: 0,
        difficulty: 2,
        feedback: 'skipped',
        now: new Date(),
      });
    }
    const { config, repoRoot } = loadConfig(repo);
    syncGate(db, SESSION, config, { repo: repoRoot });

    expect(JSON.parse(preToolGate('git commit -m "x"').stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------

describe('eklavya-gate CLI (the editor-agnostic half)', () => {
  it('allows commits in a repo that never opted in', () => {
    openGate({ required: 2 });
    expect(gateCli().status).toBe(0);
  });

  it('allows commits in an ambient repo', () => {
    repoConfig({ mode: 'ambient' });
    openGate({ required: 2 });
    expect(gateCli().status).toBe(0);
  });

  it('blocks an unpassed gate in an enforced repo', () => {
    repoConfig({ mode: 'enforced', pass_threshold: 1 });
    openGate({ required: 2 });

    const res = gateCli();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/holding this commit/);
    expect(res.stderr).toMatch(/0 of 2/);
    expect(res.stderr).toMatch(/\/eklavya:quiz/);
  });

  it('allows the commit once the gate passes', () => {
    repoConfig({ mode: 'enforced', pass_threshold: 1 });
    openGate({ required: 2, answeredWell: 2 });
    expect(gateCli().status).toBe(0);
  });

  it('allows commits when the repo has no gate history at all', () => {
    repoConfig({ mode: 'enforced' });
    expect(gateCli().status).toBe(0);
  });

  it('fails open when the database is missing', () => {
    repoConfig({ mode: 'enforced' });
    expect(sh('/bin/sh', [GATE_CLI], { cwd: repo, env: { EKLAVYA_DB: '/nonexistent/x.db' } }).status).toBe(0);
  });

  it('fails open outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-plain-'));
    try {
      expect(gateCli(plain).status).toBe(0);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('does not confuse one repo\'s gate with another\'s', () => {
    repoConfig({ mode: 'enforced', pass_threshold: 1 });
    openGate({ required: 2 });

    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-other-')));
    try {
      spawnSync('git', ['init', '-q'], { cwd: other });
      fs.writeFileSync(path.join(other, '.eklavya.json'), JSON.stringify({ mode: 'enforced' }));
      expect(gateCli(other).status).toBe(0);
      expect(gateCli(repo).status).toBe(1);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('install-git-hook.sh', () => {
  const hookPath = () => path.join(repo, '.git', 'hooks', 'pre-commit');

  it('installs an executable pre-commit hook', () => {
    const res = sh('/bin/sh', [INSTALLER, repo]);
    expect(res.status).toBe(0);
    expect(fs.existsSync(hookPath())).toBe(true);
    expect(fs.statSync(hookPath()).mode & 0o111).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    sh('/bin/sh', [INSTALLER, repo]);
    const second = sh('/bin/sh', [INSTALLER, repo]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already installed/);
  });

  it('preserves an existing pre-commit hook and still runs it', () => {
    fs.writeFileSync(hookPath(), '#!/bin/sh\necho "existing hook ran"\n', { mode: 0o755 });
    sh('/bin/sh', [INSTALLER, repo]);

    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit.local'))).toBe(true);
    expect(fs.readFileSync(hookPath(), 'utf8')).toMatch(/pre-commit\.local/);
  });

  it('restores the previous hook on uninstall', () => {
    fs.writeFileSync(hookPath(), '#!/bin/sh\necho "existing hook ran"\n', { mode: 0o755 });
    sh('/bin/sh', [INSTALLER, repo]);
    sh('/bin/sh', [INSTALLER, '--uninstall', repo]);

    expect(fs.readFileSync(hookPath(), 'utf8')).toMatch(/existing hook ran/);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit.local'))).toBe(false);
  });
});

describe('end to end: a real git commit', () => {
  function stageSomething(): void {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');
    spawnSync('git', ['add', '.'], { cwd: repo });
  }

  function commit() {
    return spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'x'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
    });
  }

  it('is blocked from a bare terminal, then allowed once the quiz passes', () => {
    repoConfig({ mode: 'enforced', pass_threshold: 1 });
    sh('/bin/sh', [INSTALLER, repo]);
    openGate({ required: 2 });
    stageSomething();

    const blocked = commit();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/holding this commit/);

    // Pass the quiz.
    for (const slug of ['csrf', 'jwt-structure']) {
      gradeConcept(db, {
        conceptId: conceptBySlug(db, slug)!.id,
        sessionId: SESSION,
        question: 'q',
        answer: 'a',
        grade: 5,
        difficulty: 2,
        feedback: null,
        now: new Date(),
      });
    }
    const { config, repoRoot } = loadConfig(repo);
    syncGate(db, SESSION, config, { repo: repoRoot });

    expect(commit().status).toBe(0);
  });

  it('never interferes in an ambient repo', () => {
    repoConfig({ mode: 'ambient' });
    sh('/bin/sh', [INSTALLER, repo]);
    openGate({ required: 2 });
    stageSomething();

    expect(commit().status).toBe(0);
  });
});
