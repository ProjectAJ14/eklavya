// Translated and adapted from microsoft/TokenEconomizer,
// tokeneconomizer/plugin/denylist.py and toolprune/tools.py at
// d3e193b8734ec76230da1e08d7929ba9d14640d8.
// Licensed under the Apache License, Version 2.0 (see ./LICENSE in this folder).
// Changes: ported from Python to TypeScript; propose mode first (nothing is
// written until the developer applies); the protected list includes
// Eklavya's own tools and the tools its quiz and delegation depend on; the
// file's original bytes are kept so a restore that undoes every change puts
// them back exactly; `.claude` reached through a symlink out of the checkout
// is refused.

import fs from 'node:fs';
import path from 'node:path';
import { isEklavyaTool } from './transcript.js';

/**
 * Tool pruning: tools a repository's sessions load and never use cost context
 * on every request. Eklavya proposes denying them in this checkout's
 * `.claude/settings.local.json`, and writes only when the developer runs
 * `eklavya toolprune apply`.
 */

/** Never proposed, whatever the evidence. */
export const PROTECTED = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite',
  'WebFetch', 'WebSearch',
  'Agent', 'Task', 'Skill', 'ToolSearch',
]);

export function isProtected(tool: string, extra: string[] = []): boolean {
  return PROTECTED.has(tool) || isEklavyaTool(tool) || extra.includes(tool);
}

export interface ToolEvidence {
  tool: string;
  /** Prompts in this repository since the tool was last used (or first seen loaded). */
  prompts_since: number;
  /** Sessions in this repository since then. */
  sessions_since: number;
}

export interface ProposalRule {
  evidence: number;
  min_sessions: number;
  sessions: number;
  protect: string[];
}

/** Unused for `evidence` prompts across `min_sessions` sessions, or for `sessions` sessions. */
export function propose(rows: ToolEvidence[], rule: ProposalRule): ToolEvidence[] {
  return rows
    .filter((r) => !isProtected(r.tool, rule.protect))
    .filter((r) => (r.prompts_since >= rule.evidence && r.sessions_since >= rule.min_sessions) || r.sessions_since >= rule.sessions)
    .sort((a, b) => b.sessions_since - a.sessions_since || b.prompts_since - a.prompts_since || a.tool.localeCompare(b.tool));
}

/** What an apply did, kept so restore can undo exactly that. */
export interface WriteRecord {
  file: string;
  /** The file's bytes before the first apply; null when Eklavya created it. */
  original: string | null;
  /** Deny entries Eklavya added. */
  added: string[];
  /** The line Eklavya added to `.git/info/exclude`, if it did. */
  excludeLine: string | null;
}

export type ApplyResult = { ok: true; record: WriteRecord } | { ok: false; reason: string };

/** Is `target` (followed through symlinks) inside `root`? */
function inside(root: string, target: string): boolean {
  const rel = path.relative(fs.realpathSync(root), target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Two spaces unless the file's first indented line says otherwise. */
const indentOf = (text: string) => /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';

/** The settings file for a checkout, refusing a `.claude` that leads out of it. */
export function settingsPath(repoRoot: string): { file: string } | { reason: string } {
  const dir = path.join(repoRoot, '.claude');
  if (fs.existsSync(dir) && !inside(repoRoot, fs.realpathSync(dir))) {
    return { reason: '.claude is a symlink that leads out of the repository' };
  }
  const file = path.join(dir, 'settings.local.json');
  if (fs.existsSync(file) && !inside(repoRoot, fs.realpathSync(file))) {
    return { reason: 'settings.local.json is a symlink that leads out of the repository' };
  }
  return { file };
}

function readSettings(file: string): { text: string | null; json: Record<string, unknown> } | { reason: string } {
  if (!fs.existsSync(file)) return { text: null, json: {} };
  const text = fs.readFileSync(file, 'utf8');
  try {
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { reason: 'settings.local.json is not a JSON object' };
    const perms = (json as Record<string, unknown>).permissions;
    if (perms !== undefined && (!perms || typeof perms !== 'object' || Array.isArray(perms))) {
      return { reason: 'settings.local.json has a permissions value that is not an object' };
    }
    const deny = (perms as Record<string, unknown> | undefined)?.deny;
    if (deny !== undefined && !Array.isArray(deny)) return { reason: 'settings.local.json has a permissions.deny that is not a list' };
    return { text, json: json as Record<string, unknown> };
  } catch {
    return { reason: 'settings.local.json is not valid JSON' };
  }
}

function writeJson(file: string, json: unknown, indent: string, trailingNewline: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.eklavya-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, indent) + (trailingNewline ? '\n' : ''));
  fs.renameSync(tmp, file);
}

/**
 * Adds `tools` to `permissions.deny` as bare names, leaving every existing
 * rule alone. `previous` is the record of an earlier apply to this file, so a
 * second apply keeps the first one's original bytes.
 */
export function applyDeny(repoRoot: string, tools: string[], previous: WriteRecord | null = null): ApplyResult {
  const where = settingsPath(repoRoot);
  if ('reason' in where) return { ok: false, reason: where.reason };
  const read = readSettings(where.file);
  if ('reason' in read) return { ok: false, reason: read.reason };
  const json = read.json;
  const perms = (json.permissions ??= {}) as Record<string, unknown>;
  const deny = (perms.deny ??= []) as unknown[];
  const added = tools.filter((t) => !deny.includes(t));
  const record: WriteRecord = previous
    ? { ...previous, added: [...new Set([...previous.added, ...added])] }
    : { file: where.file, original: read.text, added, excludeLine: null };
  if (!added.length) return { ok: true, record };
  deny.push(...added);
  writeJson(where.file, json, read.text ? indentOf(read.text) : '  ', read.text ? read.text.endsWith('\n') : true);
  if (read.text === null && !previous) record.excludeLine = excludeFile(repoRoot, where.file);
  return { ok: true, record };
}

/** Adds the file to `.git/info/exclude` when Eklavya created it; returns the line, or null. */
function excludeFile(repoRoot: string, file: string): string | null {
  const exclude = path.join(repoRoot, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.join(repoRoot, '.git')) || !fs.statSync(path.join(repoRoot, '.git')).isDirectory()) return null;
  const line = `/${path.relative(repoRoot, file).split(path.sep).join('/')}`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').includes(line)) return null;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  return line;
}

export type RestoreResult = { ok: true; removed: string[] } | { ok: false; reason: string };

/**
 * Removes exactly the entries Eklavya added. When nothing else in the file
 * changed since, the original bytes come back (or the file goes, if Eklavya
 * created it); otherwise only those entries leave and the rest is kept.
 */
export function restoreDeny(repoRoot: string, record: WriteRecord, only?: string[]): RestoreResult {
  const read = readSettings(record.file);
  if ('reason' in read) return { ok: false, reason: read.reason };
  const removing = only ? record.added.filter((t) => only.includes(t)) : record.added;
  const json = read.json;
  const perms = json.permissions as Record<string, unknown> | undefined;
  const deny = (perms?.deny as unknown[] | undefined) ?? [];
  const kept = deny.filter((t) => !(typeof t === 'string' && removing.includes(t)));
  const removed = removing.filter((t) => deny.includes(t));
  const remaining = record.added.filter((t) => !removing.includes(t));

  // Untouched: the file is still exactly what the apply made of the original,
  // so the original bytes (or no file) can come back.
  const original = record.original === null ? {} : (JSON.parse(record.original) as Record<string, unknown>);
  const expected = structuredClone(original);
  const ep = (expected.permissions ??= {}) as Record<string, unknown>;
  ep.deny = [...((ep.deny as unknown[] | undefined) ?? []), ...record.added.filter((t) => !((original.permissions as { deny?: unknown[] } | undefined)?.deny ?? []).includes(t))];
  const untouched = !remaining.length && JSON.stringify(read.json) === JSON.stringify(expected);
  if (perms) perms.deny = kept;
  if (untouched) {
    if (record.original === null) {
      fs.rmSync(record.file, { force: true });
      if (record.excludeLine) unexclude(repoRoot, record.excludeLine);
    } else fs.writeFileSync(record.file, record.original);
  } else if (removed.length) {
    // Something was removed, so the file exists and has text.
    writeJson(record.file, json, indentOf(read.text!), read.text!.endsWith('\n'));
  }
  return { ok: true, removed };
}

function unexclude(repoRoot: string, line: string): void {
  const exclude = path.join(repoRoot, '.git', 'info', 'exclude');
  if (!fs.existsSync(exclude)) return;
  const lines = fs.readFileSync(exclude, 'utf8').split('\n');
  const at = lines.lastIndexOf(line);
  if (at === -1) return;
  lines.splice(at, 1);
  fs.writeFileSync(exclude, lines.join('\n'));
}

/**
 * The size of tool definitions before and after denying `tools`, from a
 * catalog of definition sizes in estimated tokens. A deferred MCP tool costs
 * one listing line, not its schema, so it is counted as such.
 */
export function measure(
  catalog: Record<string, number>,
  deferred: string[],
  denied: string[],
): { before: number; after: number; saved: number } {
  const LISTING = 12;
  const cost = (t: string) => (deferred.includes(t) ? LISTING : catalog[t]!);
  const all = new Set([...Object.keys(catalog), ...deferred]);
  const before = [...all].reduce((s, t) => s + cost(t), 0);
  const after = [...all].filter((t) => !denied.includes(t)).reduce((s, t) => s + cost(t), 0);
  return { before, after, saved: before - after };
}
