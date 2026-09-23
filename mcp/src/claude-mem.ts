/**
 * Claude Mem, seen from `eklavya install`.
 *
 * Both tools record every tool call and recall it at session start. Installed
 * together, every session is captured twice and recalled twice, into two
 * databases that never agree. So install asks once which one records, and acts
 * on the answer:
 *
 *   eklavya     uninstall the Claude Mem plugin, import its history with every
 *               project it can place filed under its checkout, and retire
 *               `~/.claude-mem` (moved, never deleted — it is the rollback).
 *   claude-mem  set `memory.enabled: false`. The quiz half is unaffected.
 *
 * The hard part is the project map. Claude Mem names a project with a bare
 * string; Eklavya keys it by checkout path. Every Claude Mem session carries the
 * Claude Code session id, and Claude Code's transcript for that id records the
 * cwd — so the map is read off the transcripts rather than guessed from names.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { findRepoConfig } from './config.js';
import { projectKey } from './store.js';
import { readJsonForUpdate, writeJsonWithBackup } from './safe-write.js';

/** `CLAUDE_MEM_DATA_DIR` is Claude Mem's own override, so it is ours too. */
export function claudeMemDir(): string {
  return process.env.CLAUDE_MEM_DATA_DIR ?? path.join(os.homedir(), '.claude-mem');
}

export function claudeMemDb(): string {
  return path.join(claudeMemDir(), 'claude-mem.db');
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Every registered plugin id that is Claude Mem, whatever marketplace it came from. */
export function claudeMemPluginIds(claudeHome: string): string[] {
  const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const settings = readJson(path.join(claudeHome, 'settings.json'));
  const ids = [
    ...Object.keys((installed.plugins ?? {}) as object),
    ...Object.keys((settings.enabledPlugins ?? {}) as object),
  ];
  return [...new Set(ids.filter((id) => id.startsWith('claude-mem@')))];
}

/**
 * The ids still recording: a plugin switched off in settings.json — this
 * installer's own fallback when `claude` is not on PATH — records nothing, and
 * asking about it on every later install would be asking about a finished move.
 */
export function activeClaudeMemPluginIds(claudeHome: string): string[] {
  const enabled = (readJson(path.join(claudeHome, 'settings.json')).enabledPlugins ?? {}) as Record<string, unknown>;
  return claudeMemPluginIds(claudeHome).filter((id) => enabled[id] !== false);
}

/**
 * Removes the plugin through Claude Code's own CLI, and falls back to switching
 * it off in settings.json when `claude` is not on PATH. Off is enough to stop
 * the double recording; the fallback just cannot delete the files.
 */
export async function removeClaudeMemPlugin(
  claudeHome: string,
  ids: string[],
  /** The caller's backup run (see `WriteOptions.run`), so install keeps one true original. */
  run?: Set<string>,
): Promise<{ how: 'uninstalled' | 'disabled'; backup: string | null }> {
  let viaCli = true;
  for (const id of ids) {
    // Async so install's spinner turns while `claude` starts up, which is seconds.
    const status = await new Promise<number | null>((resolve) => {
      const child = spawn('claude', ['plugin', 'uninstall', id], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
        env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
      });
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    if (status !== 0) viaCli = false;
  }
  if (viaCli) return { how: 'uninstalled', backup: null };

  // The developer's settings file: never read as `{}` when it will not parse
  // (install checks it up front, this is the second line), and backed up first.
  const file = path.join(claudeHome, 'settings.json');
  const settings = readJsonForUpdate(file);
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
  for (const id of ids) enabled[id] = false;
  settings.enabledPlugins = enabled;
  return { how: 'disabled', backup: writeJsonWithBackup(file, settings, { run }).backup };
}

/** The first `cwd` a transcript records, or null. Only the head is read. */
function transcriptCwd(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    return m ? (JSON.parse(`"${m[1]}"`) as string) : null;
  } catch {
    return null;
  }
}

function safeMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** The checkout a path belongs to, folded through worktrees — or null if it is gone. */
function checkoutOf(dir: string | null): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const root = findRepoConfig(dir).repoRoot;
  return root ? projectKey(root) : null;
}

/**
 * Where a transcript directory's name points today. Claude Code names it after
 * the project path with every non-alphanumeric turned into `-`, and renames it
 * when the checkout moves — while the transcripts inside keep the old `cwd`. The
 * encoding is lossy (`a_b`, `a-b` and `a/b` all read `a-b`), so it is decoded by
 * walking the filesystem, keeping only segments that exist. Case-insensitive,
 * because macOS is. Returns null on anything it cannot walk, Windows included.
 */
function decodeTranscriptDir(name: string): string | null {
  const enc = (s: string) => `-${s.replace(/[^A-Za-z0-9]/g, '-')}`.toLowerCase();
  const walk = (dir: string, rest: string): string | null => {
    if (!rest) return dir;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const e of entries) {
      const seg = enc(e);
      if (rest !== seg && !rest.startsWith(`${seg}-`)) continue;
      const hit = walk(path.join(dir, e), rest.slice(seg.length));
      if (hit) return hit;
    }
    return null;
  };
  return walk('/', name.toLowerCase());
}

/**
 * Claude Mem project name → Eklavya project key, for every project that can be
 * placed. A project is placed by majority vote over its sessions' transcripts —
 * each session counts for the checkout its `cwd` is in, or, where that path is
 * gone, the checkout its transcript directory now points at. Failing that, by a
 * unique live checkout whose folder carries the same name. Failing that, a
 * checkout that moved: from the nearest folder of the recorded path that still
 * exists, one carrying the project's name up to two levels down. More than
 * one is not a guess this makes -- the candidates go into `unsure` for the
 * caller to show. Anything else is left out, and the importer keeps it as-is —
 * searchable with `--all-projects`, mappable later with `--map`.
 *
 * ponytail: reads at most 20 transcripts per project, which is plenty to vote.
 */
export function guessProjectMap(
  sourceDb: string,
  claudeHome: string,
  unsure: Record<string, string[]> = {},
): Record<string, string> {
  const projectsDir = path.join(claudeHome, 'projects');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return {};
  }

  const byId = new Map<string, { file: string; dirRoot: string | null }>();
  const liveByName = new Map<string, Set<string>>();
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(projectsDir, d)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const paths = files.map((f) => path.join(projectsDir, d, f));
    // The newest transcript is likeliest to name where the project lives now.
    let newest: string | undefined;
    let newestAt = -1;
    for (const file of paths) {
      const at = safeMtime(file);
      if (at > newestAt) [newest, newestAt] = [file, at];
    }
    const dirRoot = checkoutOf(newest ? transcriptCwd(newest) : null) ?? checkoutOf(decodeTranscriptDir(d));
    for (const file of paths) byId.set(path.basename(file, '.jsonl'), { file, dirRoot });
    if (dirRoot) {
      const name = path.basename(dirRoot);
      liveByName.set(name, (liveByName.get(name) ?? new Set()).add(dirRoot));
    }
  }

  const src = new Database(sourceDb, { readonly: true, fileMustExist: true });
  let rows: Array<{ project: string; ids: string | null }> = [];
  try {
    rows = src
      .prepare('SELECT project, group_concat(content_session_id) AS ids FROM sdk_sessions GROUP BY project')
      .all() as typeof rows;
  } catch {
    /* no sdk_sessions: nothing to vote with */
  } finally {
    src.close();
  }

  const map: Record<string, string> = {};
  for (const { project, ids } of rows) {
    const votes = new Map<string, number>();
    let lost: string | null = null;
    for (const id of (ids ?? '').split(',').slice(0, 20)) {
      const t = byId.get(id);
      const cwd = t ? transcriptCwd(t.file) : null;
      const root = t ? checkoutOf(cwd) ?? t.dirRoot : null;
      if (root) votes.set(root, (votes.get(root) ?? 0) + 1);
      else if (cwd && !fs.existsSync(cwd)) lost ??= cwd;
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    const byName = liveByName.get(path.basename(project));
    if (best) map[project] = best[0];
    else if (byName?.size === 1) map[project] = [...byName][0]!;
    else if (lost) {
      const moved = relocate(lost, path.basename(project));
      if (moved.length === 1) map[project] = moved[0]!;
      else if (moved.length > 1) unsure[project] = moved;
    }
  }
  return map;
}

/**
 * Checkouts named `name` near where `lost` used to be: from its nearest
 * surviving ancestor, two levels down. `~/Workspace/Personal/PiDom` moved to
 * `~/Workspace/local/PiDom` is found; a folder of that name inside some other
 * repository is not, because it must be a checkout root of its own.
 */
function relocate(lost: string, name: string): string[] {
  let dir = path.dirname(lost);
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return [];
    dir = up;
  }
  const found = new Set<string>();
  const look = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.name === name) {
        const root = checkoutOf(p);
        if (root && path.basename(root) === name) found.add(root);
      } else if (depth > 1) look(p, depth - 1);
    }
  };
  look(dir, 2);
  return [...found].sort();
}

/** `~/.claude-mem` → `~/.claude-mem.retired` (or `.retired-2`, …). Never a delete. */
export function retireClaudeMemDir(): string {
  const from = claudeMemDir();
  let to = `${from}.retired`;
  for (let i = 2; fs.existsSync(to); i++) to = `${from}.retired-${i}`;
  fs.renameSync(from, to);
  return to;
}
