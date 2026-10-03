/**
 * Artifacts: self-contained HTML pages an agent writes to explain something —
 * a concept the developer got wrong, a design, a report — kept under
 * `~/.eklavya/artifacts/<project slug>/`.
 *
 * Three rules shape this file.
 *
 * **The files are the index.** There is no table. `listArtifacts` reads each
 * page's `<head>` for the metadata `createArtifact` stamped into it, so a page
 * deleted, renamed or copied in by hand is reflected on the next read, and
 * there is nothing to fall out of step with the disk. The ceiling is a scan of
 * every file per dashboard load; `HEAD_BYTES` keeps each read small, and a few
 * thousand pages is still milliseconds.
 *
 * **The design tokens are inlined at creation, not copied into the template.**
 * `tokens.css` is the one palette the site and the dashboard share; a second
 * hand-kept copy inside a template is the copy nobody updates. Inlining makes
 * the page self-contained — its "download HTML" button hands over a file that
 * still themes and prints — without a second source.
 *
 * **Every path in is untrusted.** `resolveArtifact` is what the dashboard
 * serves through, and it refuses anything that does not land on an `.html`
 * file directly inside one project folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoConfig, mainRepoRoot } from './config.js';
import { artifactsDir, projectSlug } from './paths.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Enough of a file to hold its `<head>`: the metadata is written first. */
const HEAD_BYTES = 16 * 1024;

export type ArtifactKind = 'artifact' | 'explainer';

export interface ArtifactRow {
  /** `<project folder>/<file>` — the dashboard's handle, and its URL path. */
  id: string;
  title: string;
  description: string;
  /** The checkout (or directory) it was written for, as an absolute path. */
  project: string | null;
  kind: ArtifactKind;
  concept: string | null;
  /** The missed attempt an explainer was written for (`--attempt`), or null. */
  attempt: number | null;
  created: string;
  bytes: number;
}

/** What a page is filed under: the main checkout behind a worktree, else the directory itself. */
export function artifactProject(cwd: string = process.cwd()): string {
  const { repoRoot } = findRepoConfig(cwd);
  if (repoRoot) return mainRepoRoot(repoRoot);
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

export function kebab(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'artifact';
}

export const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function assetPath(name: string): string {
  return path.join(moduleDir, 'assets', name);
}

/** The shared tokens, minus the remote font import (the template links the fonts itself). */
function inlineTokens(): string {
  try {
    const css = fs.readFileSync(assetPath('tokens.css'), 'utf8');
    return css.replace(/@import\s+url\([^)]*\)[^;]*;\s*/gi, '');
  } catch {
    // A build without the tokens still writes the page; it renders unstyled
    // until the tokens are restored, rather than failing the command.
    return '';
  }
}

export interface CreateOptions {
  title: string;
  description?: string;
  kind?: ArtifactKind;
  concept?: string | null;
  /** The missed attempt this explainer is for: what lets the dashboard offer a correction. */
  attempt?: number | null;
  cwd?: string;
  now?: Date;
}

/**
 * Writes the template, filled in, to a fresh file and returns its path. Never
 * overwrites: a second page with the same title on the same day gets `-2`.
 */
export function createArtifact(opts: CreateOptions): { path: string; id: string; project: string } {
  const title = opts.title.trim();
  if (!title) throw new Error('an artifact needs a title');
  const now = opts.now ?? new Date();
  const project = artifactProject(opts.cwd);
  const folder = projectSlug(project);
  const dir = path.join(artifactsDir(), folder);
  fs.mkdirSync(dir, { recursive: true });

  // The local date, not UTC: the filename is for the person reading their folder.
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const stem = `${day}-${kebab(title)}`;
  let file = `${stem}.html`;
  for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${stem}-${n}.html`;

  const description = (opts.description ?? '').trim();
  const kind = opts.kind ?? 'artifact';
  const fill: Record<string, string> = {
    '{{TITLE}}': escHtml(title),
    '{{DESCRIPTION}}': escHtml(description),
    '{{PROJECT}}': escHtml(project),
    '{{PROJECT_NAME}}': escHtml(path.basename(project) || project),
    '{{KIND}}': kind,
    '{{CONCEPT}}': escHtml(opts.concept ?? ''),
    '{{ATTEMPT}}': opts.attempt ? String(opts.attempt) : '',
    '{{CREATED}}': now.toISOString(),
    '{{EYEBROW}}': kind === 'explainer' ? 'Explainer' : 'Artifact',
  };
  let html = fs.readFileSync(assetPath('artifact-template.html'), 'utf8');
  // Tokens first: the CSS contains no placeholders, but user text could.
  html = html.replace('/*{{TOKENS}}*/', () => inlineTokens());
  html = html.replace(/\{\{[A-Z_]+\}\}/g, (m) => fill[m] ?? m);

  const target = path.join(dir, file);
  fs.writeFileSync(target, html, { flag: 'wx' });
  return { path: target, id: `${folder}/${file}`, project };
}

function meta(head: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
  const m = re.exec(head);
  return m ? unescHtml(m[1]!) : null;
}

/** A positive integer, or null: an `--attempt` that is anything else links nothing. */
export function attemptId(raw: string | null | undefined): number | null {
  return raw && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
}

function unescHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!,
  );
}

function readHead(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The dashboard id (`<folder>/<file>`) of a file inside the artifact root, or null. */
export function artifactIdOf(file: string, root: string = artifactsDir()): string | null {
  let id: string;
  try {
    id = path.relative(fs.realpathSync(root), fs.realpathSync(file)).split(path.sep).join('/');
  } catch {
    return null;
  }
  return resolveArtifact(id, root) ? id : null;
}

/**
 * Every artifact on disk, newest first. A page with no Eklavya metadata — one
 * copied in by hand — is still listed, titled from its `<title>` or filename.
 * Never throws: an unreadable file costs that one row.
 */
export function listArtifacts(root: string = artifactsDir()): ArtifactRow[] {
  const rows: ArtifactRow[] = [];
  for (const { folder, name, file, st } of artifactFiles(root)) {
    try {
      const head = readHead(file);
      const title = /<title>([^<]*)<\/title>/i.exec(head)?.[1]?.trim();
      const kind = meta(head, 'eklavya:kind');
      rows.push({
        id: `${folder}/${name}`,
        title: title ? unescHtml(title) : name.replace(/\.html?$/i, ''),
        description: meta(head, 'description') ?? '',
        project: meta(head, 'eklavya:project') || null,
        kind: kind === 'explainer' ? 'explainer' : 'artifact',
        concept: meta(head, 'eklavya:concept') || null,
        attempt: attemptId(meta(head, 'eklavya:attempt')),
        created: meta(head, 'eklavya:created') || st.mtime.toISOString(),
        bytes: st.size,
      });
    } catch {
      continue;
    }
  }
  return rows.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
}

/**
 * What changes when the artifact list would: how many pages, their total size
 * and the newest modification time. `lstat` only, never a read, so the
 * dashboard's poll can afford it once a minute. Same folder and file rules as
 * `listArtifacts`; the stamp is only for comparing with an earlier one.
 */
export function artifactsStamp(root: string = artifactsDir()): string {
  let count = 0;
  let bytes = 0;
  let newest = 0;
  for (const { st } of artifactFiles(root)) {
    count += 1;
    bytes += st.size;
    newest = Math.max(newest, st.mtimeMs);
  }
  return `${count}.${bytes}.${Math.floor(newest)}`;
}

/**
 * Every page file under the root, stat'ed but not read. The rules
 * `resolveArtifact` serves by, so nothing is listed that the dashboard would
 * then refuse: no dot-names, no symlinks -- a link's `<head>` would otherwise
 * be read from wherever it points. An unreadable folder or file costs itself.
 */
function artifactFiles(root: string): { folder: string; name: string; file: string; st: fs.Stats }[] {
  const out: { folder: string; name: string; file: string; st: fs.Stats }[] = [];
  let folders: fs.Dirent[];
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const folder of folders) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, folder.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!/\.html?$/i.test(name) || name.startsWith('.')) continue;
      const file = path.join(root, folder.name, name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile()) out.push({ folder: folder.name, name, file, st });
        /* c8 ignore next 3 -- removed between the listing and the lstat */
      } catch {
        continue;
      }
    }
  }
  return out;
}

/**
 * The file behind an id, or null. Exactly `<folder>/<file>.html`, both plain
 * names — no separators, no `..`, no leading dot — and the resolved path must
 * still sit inside the root after symlinks, so a link planted in a project
 * folder cannot serve a file from elsewhere on the machine.
 */
export function resolveArtifact(id: string, root: string = artifactsDir()): string | null {
  const parts = id.split('/');
  if (parts.length !== 2) return null;
  const plain = /^[^/\\\0]+$/;
  for (const p of parts) if (!plain.test(p) || p.startsWith('.')) return null;
  if (!/\.html?$/i.test(parts[1]!)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(root, parts[0]!, parts[1]!));
    if (path.dirname(path.dirname(real)) !== realRoot) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Past this, a page is not scanned for its diagram; the gallery shows the cover. */
const THUMB_MAX_BYTES = 4 * 1024 * 1024;

/** A page with no diagram still gets a picture: a sheet with ruled lines, drawn in the tokens. */
const COVER =
  '<svg viewBox="0 0 320 200"><g fill="none" style="stroke:var(--faint-2)" stroke-width="2" stroke-linecap="round">' +
  '<path d="M136 52h36l14 14v82h-50z"/><path d="M172 52v14h14"/><path d="M148 96h26M148 112h26M148 128h16"/></g></svg>';

/**
 * A page's thumbnail for the gallery: its first diagram — the first `<svg>`
 * inside a `<figure>` — as a standalone SVG document, or the cover when it has
 * none. The page's own `<style>` blocks go with it, so the `.svg-*` classes and
 * the inlined tokens resolve as they do in the page, and `data-mode` on the
 * root picks the ground (the tokens key it off `:root`). An `<img>` runs no
 * script and fetches nothing, so the markup needs no cleaning; served with
 * `ARTIFACT_CSP` it is sandboxed when opened directly too.
 */
export function artifactThumb(file: string, mode: 'ink' | 'paper'): string {
  // Comments first: the template's own instructions mention a <figure>.
  const html = fs.statSync(file).size > THUMB_MAX_BYTES ? ''
    : fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const fig = html.search(/<figure[\s>]/i);
  const start = fig < 0 ? -1 : html.indexOf('<svg', fig);
  const figEnd = html.indexOf('</figure>', fig);
  // ponytail: the first </svg> closes it, so a nested <svg> cuts the diagram
  // short and the image fails to decode. Upgrade: count nesting if one appears.
  const end = start < 0 ? -1 : html.indexOf('</svg>', start);
  const found = start >= 0 && end >= 0 && (figEnd < 0 || start < figEnd);
  const svg = found ? html.slice(start, end + '</svg>'.length) : COVER;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + svg.replace(/^<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\s(xmlns|width|height|data-mode)="[^"]*"/g, '')
      .replace(/^<svg/, `<svg xmlns="http://www.w3.org/2000/svg" data-mode="${mode}"`)
      .replace(/>$/, `><style><![CDATA[${css.replaceAll(']]>', '')}\n:root{color:var(--dim)}]]></style>`),
  );
}
