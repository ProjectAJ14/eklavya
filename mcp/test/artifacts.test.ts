import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createArtifact, listArtifacts, resolveArtifact, artifactProject, kebab } from '../src/artifacts.js';
import { artifactsDir, projectSlug } from '../src/paths.js';
import { openDb, type DB } from '../src/db.js';
// The template and tokens are copied in by the build, so these run the built modules.
import { createArtifact as createBuilt } from '../dist/artifacts.js';
import { startDashboard as startBuilt, dashboardState } from '../dist/dashboard.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

let tmp = '';
let repo = '';
const saved = process.env.EKLAVYA_HOME;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-artifacts-')));
  process.env.EKLAVYA_HOME = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('createArtifact', () => {
  it('files a page under the project it was written in, from any directory inside it', () => {
    const made = createBuilt({ title: 'Refresh token rotation', cwd: path.join(repo, 'src'), now: new Date(2026, 8, 24, 10) });
    expect(made.project).toBe(repo);
    expect(made.path).toBe(path.join(artifactsDir(), projectSlug(repo), '2026-09-24-refresh-token-rotation.html'));
    expect(fs.existsSync(made.path)).toBe(true);
  });

  it('folds a worktree into its main checkout, as settings do', () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'b'), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'b')}\n`);
    expect(artifactProject(wt)).toBe(repo);
  });

  it('never overwrites: the same title twice on one day gets a suffix', () => {
    const now = new Date(2026, 8, 24);
    const a = createBuilt({ title: 'Same', cwd: repo, now });
    const b = createBuilt({ title: 'Same', cwd: repo, now });
    expect(path.basename(b.path)).toBe('2026-09-24-same-2.html');
    expect(a.path).not.toBe(b.path);
  });

  it('escapes what it writes, inlines the tokens, and leaves no placeholder behind', () => {
    const made = createBuilt({
      title: '<script>alert(1)</script> & "quotes"',
      description: 'a "desc" <b>',
      kind: 'explainer',
      concept: 'csrf',
      cwd: repo,
    });
    const html = fs.readFileSync(made.path, 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain('--bg:');
    expect(html).not.toMatch(/@import url/);

    const [row] = listArtifacts();
    expect(row).toMatchObject({
      title: '<script>alert(1)</script> & "quotes"',
      description: 'a "desc" <b>',
      kind: 'explainer',
      concept: 'csrf',
      project: repo,
    });
  });

  it('refuses an empty title', () => {
    expect(() => createArtifact({ title: '   ', cwd: repo })).toThrow(/title/);
  });
});

describe('listArtifacts', () => {
  it('is empty with no directory, lists newest first, and keeps a hand-copied page', () => {
    expect(listArtifacts()).toEqual([]);
    createBuilt({ title: 'Older', cwd: repo, now: new Date('2026-01-01T00:00:00Z') });
    createBuilt({ title: 'Newer', cwd: repo, now: new Date('2026-02-01T00:00:00Z') });
    const loose = path.join(artifactsDir(), 'misc');
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(loose, 'notes.html'), '<html><body>hi</body></html>');
    fs.writeFileSync(path.join(loose, 'ignored.txt'), 'x');
    const rows = listArtifacts();
    expect(rows.map((r) => r.title)).toEqual(['notes', 'Newer', 'Older']);
    expect(rows[0]).toMatchObject({ project: null, kind: 'artifact', id: 'misc/notes.html' });
  });
});

describe('resolveArtifact', () => {
  it('serves only an html file directly inside one project folder', () => {
    const made = createBuilt({ title: 'Real', cwd: repo });
    const id = made.id;
    expect(resolveArtifact(id)).toBe(made.path);
    fs.writeFileSync(path.join(tmp, 'home', 'secret.html'), 'x');
    for (const bad of [
      '../secret.html', 'x/../../secret.html', `${id}/..`, '..%2Fsecret.html', 'secret.html',
      `.hidden/${path.basename(made.path)}`, `${path.dirname(id)}/missing.html`, `${path.dirname(id)}/x.txt`, '',
    ]) {
      expect(resolveArtifact(bad), bad).toBeNull();
    }
  });

  it('refuses a symlink that points outside the artifacts folder', () => {
    createBuilt({ title: 'Real', cwd: repo });
    const outside = path.join(tmp, 'outside.html');
    fs.writeFileSync(outside, 'secret');
    const folder = projectSlug(repo);
    fs.symlinkSync(outside, path.join(artifactsDir(), folder, 'link.html'));
    expect(resolveArtifact(`${folder}/link.html`)).toBeNull();
  });
});

describe('kebab', () => {
  it('makes a filename-safe slug and never an empty one', () => {
    expect(kebab('Why SM-2 & Decay?')).toBe('why-sm-2-decay');
    expect(kebab('Café résumé')).toBe('cafe-resume');
    expect(kebab('!!!')).toBe('artifact');
  });
});

describe('the dashboard', () => {
  let dbFile = '';
  let db: DB;
  beforeEach(() => {
    dbFile = path.join(tmp, 'k.db');
    db = openDb(dbFile);
  });
  afterEach(() => db.close());

  const get = (port: number, p: string, host = '127.0.0.1') =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }).on('error', reject);
    });

  it('lists artifacts in /api/state', () => {
    createBuilt({ title: 'Listed', cwd: repo });
    const s = dashboardState(db as any) as any;
    expect(s.artifacts).toEqual([expect.objectContaining({ title: 'Listed', project: repo })]);
  });

  it('serves a page sandboxed, and refuses traversal and a rebound host', async () => {
    const made = createBuilt({ title: 'Served', cwd: repo });
    const { url, close } = await startBuilt(db as any, { port: 0 });
    const port = Number(new URL(url).port);
    try {
      const ok = await get(port, '/artifacts/' + made.id.split('/').map(encodeURIComponent).join('/'));
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('<h1>Served</h1>');
      const csp = String(ok.headers['content-security-policy']);
      expect(csp).toMatch(/^sandbox /);
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).toContain("default-src 'none'");
      expect(ok.headers['x-frame-options']).toBe('DENY');

      for (const bad of ['/artifacts/..%2F..%2Fknowledge.db', '/artifacts/%E0%A4%A', '/artifacts/x/../../k.db']) {
        const r = await get(port, bad);
        expect(r.status, bad).toBeGreaterThanOrEqual(400);
        expect(String(r.headers['content-security-policy']), bad).toContain("default-src 'self'");
      }
      expect((await get(port, '/artifacts/' + made.id, 'evil.example')).status).toBe(403);
    } finally {
      close();
    }
  });
});

describe('eklavya artifacts', () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [CLI, 'artifacts', ...args], {
      cwd: repo,
      env: { ...process.env, EKLAVYA_HOME: path.join(tmp, 'home') },
      encoding: 'utf8',
    });

  it('new prints the path, list finds it, and --here narrows to this project', () => {
    const file = run('new', 'CLI', 'made', '--description', 'from the CLI', '--kind', 'explainer', '--concept', 'csrf').trim();
    expect(path.basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}-cli-made\.html$/);
    expect(fs.readFileSync(file, 'utf8')).toContain('<meta name="eklavya:kind" content="explainer">');
    const rows = JSON.parse(run('list', '--json', '--here'));
    expect(rows).toEqual([expect.objectContaining({ title: 'CLI made', description: 'from the CLI', concept: 'csrf' })]);
  });

  it('refuses a missing title and an unknown kind', () => {
    expect(() => run('new')).toThrow();
    expect(() => run('new', 'x', '--kind', 'poster')).toThrow();
  });
});

describe('record_attempt and explain_on_wrong', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(path.join(tmp, 'k.db'));
  });
  afterEach(() => db.close());

  const setExplain = (on: boolean) => {
    fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'home', 'config.json'), JSON.stringify({ explain_on_wrong: on }));
  };
  const attempt = async (args: Record<string, unknown>) => {
    const { recordAttempt } = await import('../src/tools/record_attempt.js');
    return recordAttempt.handler(
      { cwd: repo, session_id: 's', slug: 'csrf', question: `q ${Math.random()}`, difficulty: 2, ...args },
      { db } as any,
    ) as any;
  };

  it('stays silent by default, even on a wrong answer', async () => {
    const r = await attempt({ answer: 'wrong', grade: 1, outcome: 'answered' });
    expect(r.explain).toBeUndefined();
  });

  it('hands back an explain block on a miss and a taught blank, never on a pass, skip or decline', async () => {
    setExplain(true);
    const miss = await attempt({ answer: 'wrong', grade: 2, outcome: 'answered' });
    expect(miss.explain).toMatchObject({ concept: 'csrf', answer: 'wrong' });
    expect(miss.explain.instruction).toMatch(/background/);
    expect((await attempt({ grade: 0, outcome: 'dont_know' })).explain).toBeDefined();
    expect((await attempt({ answer: 'right', grade: 4, outcome: 'answered' })).explain).toBeUndefined();
    expect((await attempt({ grade: 0 })).explain).toBeUndefined();
    expect((await attempt({ grade: 0, outcome: 'declined' })).explain).toBeUndefined();
  });
});

describe('review fixes', () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [CLI, 'artifacts', ...args], {
      cwd: repo,
      env: { ...process.env, EKLAVYA_HOME: path.join(tmp, 'home') },
      encoding: 'utf8',
    });

  it('new takes --flag=value, refuses an unknown flag, and allows a dashed title after --', () => {
    const file = run('new', 'Eq form', '--kind=explainer', '--concept=csrf').trim();
    expect(fs.readFileSync(file, 'utf8')).toContain('<meta name="eklavya:kind" content="explainer">');
    expect(() => run('new', 'x', '--kinda', 'explainer')).toThrow();
    expect(() => run('new', 'x', '--kind')).toThrow();
    expect(path.basename(run('new', '--', '--dry-run flag').trim())).toMatch(/-dry-run-flag\.html$/);
  });

  it('lists nothing the server would refuse: no symlinks, no dot-names', () => {
    createBuilt({ title: 'Real', cwd: repo });
    const folder = path.join(artifactsDir(), projectSlug(repo));
    const outside = path.join(tmp, 'outside.html');
    fs.writeFileSync(outside, '<title>leaked</title>');
    fs.symlinkSync(outside, path.join(folder, 'link.html'));
    fs.writeFileSync(path.join(folder, '.hidden.html'), '<title>hidden</title>');
    fs.mkdirSync(path.join(artifactsDir(), '.dot'));
    fs.writeFileSync(path.join(artifactsDir(), '.dot', 'x.html'), '<title>dot</title>');
    expect(listArtifacts().map((r) => r.title)).toEqual(['Real']);
  });
});
