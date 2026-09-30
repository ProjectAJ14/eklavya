/**
 * Artifacts' fail-soft paths: a missing build asset, an unreadable folder or
 * file, and the odd shapes a hand-managed folder can hold. The template and
 * tokens are copied in by the build, so these run the built module.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { artifactProject, artifactThumb, createArtifact, listArtifacts, resolveArtifact } from '../dist/artifacts.js';

let tmp = '';
let root = '';
const saved = process.env.EKLAVYA_HOME;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-art-cov-')));
  process.env.EKLAVYA_HOME = path.join(tmp, 'home');
  root = path.join(tmp, 'artifacts');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fails one path's read with `err`, passing every other call through. */
function failFor<K extends 'readFileSync' | 'readdirSync' | 'openSync'>(fn: K, match: (p: string) => boolean, result: () => unknown) {
  const orig = fs[fn] as (...a: unknown[]) => unknown;
  vi.spyOn(fs, fn).mockImplementation(((p: unknown, ...rest: unknown[]) =>
    match(String(p)) ? result() : orig.call(fs, p, ...rest)) as never);
}

describe('artifactProject outside a repository', () => {
  it('files under the directory itself, resolved, and under the path as given when it does not exist', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.symlinkSync(plain, path.join(tmp, 'link'));
    expect(artifactProject(path.join(tmp, 'link'))).toBe(plain);
    expect(artifactProject(path.join(tmp, 'missing', '..', 'gone'))).toBe(path.join(tmp, 'gone'));
  });
});

describe('createArtifact', () => {
  it('still writes the page when the tokens are missing from the build', () => {
    failFor('readFileSync', (p) => p.endsWith('tokens.css'), () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const made = createArtifact({ title: 'Unstyled', cwd: path.join(tmp, 'x') });
    const html = fs.readFileSync(made.path, 'utf8');
    expect(html).toContain('Unstyled');
    expect(html).not.toContain('/*{{TOKENS}}*/');
    expect(html).not.toMatch(/--[a-z-]+:\s*#/);
  });

  it('leaves a placeholder it does not know as written, and names a root-level project by its path', () => {
    failFor('readFileSync', (p) => p.endsWith('artifact-template.html'), () =>
      '<title>{{TITLE}}</title><p>{{PROJECT_NAME}}</p><p>{{NOT_A_FIELD}}</p><style>/*{{TOKENS}}*/</style>');
    const made = createArtifact({ title: 'Root', cwd: path.parse(tmp).root });
    const html = fs.readFileSync(made.path, 'utf8');
    expect(html).toContain('{{NOT_A_FIELD}}');
    expect(html).toContain(`<p>${path.parse(tmp).root}</p>`);
  });
});

describe('listArtifacts', () => {
  const page = (dir: string, name: string, created: string) =>
    fs.writeFileSync(path.join(root, dir, name), `<title>${name}</title><meta name="eklavya:created" content="${created}">`);

  it('skips a folder it cannot read and a file it cannot open, keeping the rest', () => {
    fs.mkdirSync(path.join(root, 'locked'));
    page('locked', 'hidden.html', '2026-01-01T00:00:00.000Z');
    page('proj', 'ok.html', '2026-01-02T00:00:00.000Z');
    page('proj', 'broken.html', '2026-01-03T00:00:00.000Z');
    const eacces = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    failFor('readdirSync', (p) => p === path.join(root, 'locked'), eacces);
    failFor('openSync', (p) => p === path.join(root, 'proj', 'broken.html'), eacces);
    expect(listArtifacts(root).map((r) => r.id)).toEqual(['proj/ok.html']);
  });

  it('orders pages created at the same instant stably, and newer ones first', () => {
    page('proj', 'a.html', '2026-01-01T00:00:00.000Z');
    page('proj', 'b.html', '2026-01-01T00:00:00.000Z');
    page('proj', 'c.html', '2026-02-01T00:00:00.000Z');
    const ids = listArtifacts(root).map((r) => r.id);
    expect(ids[0]).toBe('proj/c.html');
    expect(ids.slice(1).sort()).toEqual(['proj/a.html', 'proj/b.html']);
  });
});

describe('resolveArtifact and artifactThumb', () => {
  it('refuses a directory named like a page', () => {
    fs.mkdirSync(path.join(root, 'proj', 'dir.html'));
    expect(resolveArtifact('proj/dir.html', root)).toBeNull();
  });

  it('shows the cover for a page too large to scan', () => {
    const file = path.join(root, 'proj', 'huge.html');
    fs.writeFileSync(file, '<figure><svg viewBox="0 0 1 1"><circle r="1"/></svg></figure>' + ' '.repeat(4 * 1024 * 1024));
    const svg = artifactThumb(file, 'ink');
    expect(svg).not.toContain('<circle');
    expect(svg).toContain('M136 52h36');
    expect(svg).toContain('data-mode="ink"');
  });
});
