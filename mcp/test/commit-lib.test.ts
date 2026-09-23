import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCommitCommand } from '../src/hooks/commit-lib.js';
import { openDb, type DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { conceptBySlug, logSessionConcept, syncGate } from '../src/store.js';
import { tempDbPath, cleanup } from './helpers.js';

// Every one of these slipped past the single regex the gate used to be.
const CAUGHT: string[] = [
  'git commit -m x',
  'git commit',
  'npm test && git commit -m x',
  'npm test\ngit commit -m x',
  'npm test \\\n  && git commit -m x',
  '(git commit -m x)',
  '{ git commit -m x; }',
  '/usr/bin/git commit -m x',
  'env git commit -m x',
  'env -i PATH=/usr/bin git commit -m x',
  'command git commit -m x',
  'time git commit -m x',
  'nice git commit -m x',
  'nice -n 5 git commit -m x',
  'nohup git commit -m x',
  'timeout 30 git commit -m x',
  'VAR=x git commit -m x',
  'GIT_AUTHOR_NAME="A B" git commit -m x',
  'sudo git commit -m x',
  'sudo -u me git commit -m x',
  'bash -c "git commit -m x"',
  "sh -c 'git commit -m x'",
  "bash -lc 'cd sub && git commit -m x'",
  'eval "git commit -m x"',
  'git -C "my dir" commit -m x',
  'git -C . commit -m x',
  'git -c user.name=x commit -m x',
  'git --no-pager commit -m x',
  'git --git-dir=.git commit -m x',
  'git --git-dir .git --work-tree . commit -m x',
  'echo $(git commit -m x)',
  'echo "$(git commit -m x)"',
  'echo `git commit -m x`',
  'git ls-files -m | xargs git commit -m x',
  'if true; then git commit -m x; fi',
  'git merge --continue',
  // Claude Code's own commit idiom: a heredoc inside a substitution.
  'git commit -m "$(cat <<\'EOF\'\nfix: a thing\n\nbody line\nEOF\n)"',
  'git add . && git commit -F - <<EOF\nmessage\nEOF',
];

const PASSED: string[] = [
  'npm test',
  'git status',
  'git log --oneline',
  'git add .',
  'echo "git commit -m hi"',
  "echo 'git commit'",
  'echo git commit',
  'printf "%s" "npm test && git commit"',
  'git log --grep commit',
  'git commit-tree HEAD^{tree}',
  'git show HEAD:commit.txt',
  'gitcommit -m x',
  '# git commit -m x',
  'ls # then git commit',
  'git merge feature',
  'git merge --abort',
  'git cherry-pick abc123',
  'git revert --no-edit HEAD',
  'git rebase --continue',
  'grep -r "git commit" docs/',
  'cat <<EOF > notes.md\ngit commit -m x\nEOF',
  'cat <<-EOF\n\tgit commit -m x\n\tEOF\nls',
  'bash -c "echo git commit"',
  'rg commit',
  '',
];

describe('isCommitCommand', () => {
  it.each(CAUGHT)('catches %j', (cmd) => {
    expect(isCommitCommand(cmd)).toBe(true);
  });

  it.each(PASSED)('lets %j through', (cmd) => {
    expect(isCommitCommand(cmd)).toBe(false);
  });

  it('fails open on pathological input rather than throwing', () => {
    expect(() => isCommitCommand('('.repeat(100_000) + 'git commit')).not.toThrow();
    expect(isCommitCommand('"unterminated git commit')).toBe(false);
  });
});

// The wiring, once: the built hook must deny a case the old regex missed.
const PRE_TOOL_GATE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks', 'pre-tool-gate.js');

describe('the PreToolUse gate uses it', () => {
  let dbFile = '';
  let db: DB;
  let home = '';
  let repo = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-')));
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.eklavya.json'), JSON.stringify({ quiz: { enforced: true } }));
    dbFile = tempDbPath('commit-cmd');
    db = openDb(dbFile);
    for (const slug of ['csrf', 'pkce']) logSessionConcept(db, 's1', conceptBySlug(db, slug)!.id, 'x');
    const { config, repoRoot } = loadConfig(repo);
    syncGate(db, 's1', config, { requiredHint: 2, repo: repoRoot });
  });
  afterEach(() => {
    db.close();
    cleanup(dbFile);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const gate = (command: string) =>
    spawnSync(process.execPath, [PRE_TOOL_GATE], {
      input: JSON.stringify({ session_id: 's1', cwd: repo, tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
    });

  it.each(['npm test\ngit commit -m x', 'git merge --continue'])('denies %j', (cmd) => {
    const res = gate(cmd);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('stays silent for a quoted mention', () => {
    expect(gate('echo "npm test\ngit commit"').stdout).toBe('');
  });
});
