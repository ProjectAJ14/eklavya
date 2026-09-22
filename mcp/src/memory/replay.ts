import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { identityFor } from './identity.js';
import { prepare, type HostEvent } from './capture.js';
import { appendEvent } from './store.js';

/**
 * Transcript replay (PRD CAP-01/CAP-02).
 *
 * Hooks catch what happens while Eklavya is installed and running. Replay
 * catches everything else: the sessions before the install, a session where a
 * hook was misconfigured, and a host with no hooks at all. Both go through
 * `prepare()` in `capture.ts`, so exclusion and redaction are decided once.
 *
 * Convergence is by content rather than by identity, and deliberately so.
 * A hook stamps an event with the time it ran; a transcript stamps it with the
 * time the host recorded it, and the two are never the same millisecond — so
 * the shared `event_uid` cannot do the job here. Replay asks the cheaper
 * question instead: has this session already recorded this exact body for this
 * kind and tool? It costs one indexed lookup per replayed line, which is a
 * cost only replay pays.
 */

export interface ReplayResult {
  file: string;
  read: number;
  captured: number;
  duplicates: number;
  excluded: number;
}

interface TranscriptLine {
  type?: string;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
  toolUseResult?: unknown;
}

/**
 * Claude Code stores transcripts under a directory named after the project
 * path with every separator replaced by a dash.
 */
export function transcriptDirFor(cwd: string): string {
  const encoded = path.resolve(cwd).replace(/[/\\]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

export function transcriptsFor(cwd: string): string[] {
  const dir = transcriptDirFor(cwd);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolUsesOf(content: unknown): { name: string; input: Record<string, unknown> }[] {
  if (!Array.isArray(content)) return [];
  const uses: { name: string; input: Record<string, unknown> }[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      uses.push({ name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    }
  }
  return uses;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep']);

function kindFor(tool: string): HostEvent['kind'] {
  if (EDIT_TOOLS.has(tool)) return 'file_edit';
  if (READ_TOOLS.has(tool)) return 'file_read';
  return 'tool_use';
}

function bodyFor(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['command', 'description', 'prompt', 'pattern', 'query']) {
    if (typeof input[key] === 'string') parts.push(input[key] as string);
  }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    parts.push(`- ${(input.old_string as string).slice(0, 600)}`, `+ ${(input.new_string as string).slice(0, 600)}`);
  }
  if (!parts.length) {
    const keys = Object.keys(input).filter((k) => k !== 'content');
    if (keys.length) parts.push(keys.map((k) => `${k}=${String(input[k]).slice(0, 200)}`).join(' '));
  }
  return parts.join('\n');
}

function filesFrom(input: Record<string, unknown>): string[] {
  return [input.file_path, input.notebook_path, input.path].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}

function alreadyHave(db: DB, sessionId: string, kind: string, tool: string | null, body: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM evidence_events
       WHERE session_id = ? AND kind = ? AND IFNULL(tool, '') = ? AND body = ? LIMIT 1`,
    )
    .get(sessionId, kind, tool ?? '', body) as { hit: number } | undefined;
  return Boolean(row);
}

/** Replays one transcript file. Idempotent: running it twice captures nothing new. */
export function replayTranscript(
  db: DB,
  config: EklavyaConfig,
  file: string,
  opts: { cwd?: string; maxLines?: number } = {},
): ReplayResult {
  const result: ReplayResult = { file, read: 0, captured: 0, duplicates: 0, excluded: 0 };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return result;
  }

  const lines = text.split('\n').filter(Boolean).slice(0, opts.maxLines ?? 20_000);
  for (const raw of lines) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    // A sidechain is a subagent's own transcript; the parent's line already
    // records that the delegation happened, and replaying both files records
    // the same work twice under two identities.
    if (line.isSidechain) continue;
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    result.read++;

    const identity = identityFor({
      cwd: line.cwd ?? opts.cwd ?? process.cwd(),
      sessionId: line.sessionId ?? 'replay',
      host: 'claude-code',
    });

    const events: HostEvent[] = [];
    if (line.type === 'user') {
      const prompt = textOf(line.message?.content);
      // A user line carrying a tool result is the host echoing the agent's own
      // work back, not the developer typing. Only a real prompt is one.
      if (prompt.trim() && !line.toolUseResult) {
        events.push({ kind: 'prompt', title: 'prompt', body: prompt, occurredAt: line.timestamp, source: 'replay' });
      }
    } else {
      for (const use of toolUsesOf(line.message?.content)) {
        const body = bodyFor(use.input);
        if (!body.trim()) continue;
        events.push({
          kind: kindFor(use.name),
          tool: use.name,
          title: use.name,
          body,
          files: filesFrom(use.input),
          occurredAt: line.timestamp,
          source: 'replay',
        });
      }
    }

    for (const event of events) {
      const input = prepare(config, identity, event);
      if (!input) {
        result.excluded++;
        continue;
      }
      if (alreadyHave(db, input.sessionId, input.kind, input.tool ?? null, input.body)) {
        result.duplicates++;
        continue;
      }
      const { inserted } = appendEvent(db, input);
      if (inserted) result.captured++;
      else result.duplicates++;
    }
  }

  return result;
}

/** Replays every transcript Claude Code has for this checkout. */
export function replayProject(
  db: DB,
  config: EklavyaConfig,
  cwd: string,
  opts: { limit?: number } = {},
): ReplayResult[] {
  return transcriptsFor(cwd)
    .slice(-(opts.limit ?? 20))
    .map((file) => replayTranscript(db, config, file, { cwd }));
}
