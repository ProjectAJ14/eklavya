// Translated and adapted from microsoft/TokenEconomizer,
// tokeneconomizer/trace/claude.py at d3e193b8734ec76230da1e08d7929ba9d14640d8.
// Licensed under the Apache License, Version 2.0 (see ./LICENSE in this folder).
// Changes: ported from Python to TypeScript; one pass reads usage, tool calls
// and the deferred-tool catalog together; the 5-minute and 1-hour cache-write
// counts are kept apart; usage is split per model, per subagent type and for
// turns that called Eklavya's own tools; nothing but numbers and names is kept.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Claude Code's session transcript, read for numbers and names only.
 *
 * The transcript writes one entry per content block, each repeating its
 * message's `usage`, so summing entries over-counts; usage is keyed by message
 * id and the last entry of a message wins. Subagents write their own files
 * under `<session>/subagents/`, and their tokens belong to the session that
 * started them. Prompt text, tool arguments and results are read to classify
 * a line and then dropped: nothing returned here is content.
 */

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export const zeroUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });

export function addUsage(into: Usage, u: Usage): Usage {
  into.input += u.input;
  into.cacheRead += u.cacheRead;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
  into.output += u.output;
  return into;
}

export const totalTokens = (u: Usage): number => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * One `usage` object as the API returns it. A cache write without the
 * `cache_creation` split is a 5-minute write, the default lifetime.
 */
export function usageOf(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const split = (u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {}) as Record<string, unknown>;
  const w5 = num(split.ephemeral_5m_input_tokens);
  const w1 = num(split.ephemeral_1h_input_tokens);
  const written = num(u.cache_creation_input_tokens);
  return {
    input: num(u.input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: w5 || w1 ? w5 : written,
    cacheWrite1h: w1,
    output: num(u.output_tokens),
  };
}

/** Eklavya's own MCP tools, whichever way the server was registered. */
export const isEklavyaTool = (name: string): boolean =>
  /^mcp__(?:plugin_eklavya_eklavya|eklavya)__/.test(name);

export interface TranscriptSummary {
  sessionId: string | null;
  cwd: string | null;
  /** The Claude Code version the log says it was written by. */
  version: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Distinct assistant messages carrying usage. */
  requests: number;
  usage: Usage;
  /** Per model id, so each part is priced by the model that served it. */
  byModel: Record<string, Usage>;
  /** The model that served most requests. */
  model: string | null;
  /** Usage of subagents, per agent type (`unknown` when the parent never named it). */
  subagents: Record<string, { usage: Usage; byModel: Record<string, Usage> }>;
  /** Main-thread usage of messages that called an Eklavya tool: the quiz's share. */
  eklavya: { usage: Usage; byModel: Record<string, Usage> };
  /** Tool calls per tool name, subagents included. */
  tools: Record<string, number>;
  /** Tool calls that the host marked as errors. */
  toolErrors: number;
  prompts: number;
  /** Deferred tools the session listed (`deferred_tools_delta`). */
  deferredTools: string[];
  /** Files read: the transcript and its subagent logs. */
  files: number;
}

/** A log's lines; a missing file has none. Lines over 8 MB are skipped, not parsed. */
function lines(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l && l.length < 8 << 20);
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Was this entry a prompt the person gave? Not a tool result, a command's output, an interrupt, a summary or a subagent's. */
export function isPrompt(ev: Record<string, unknown>): boolean {
  if (ev.type !== 'user' || ev.isMeta || ev.isSidechain || ev.isCompactSummary) return false;
  let content = (ev.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    const blocks = content.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object');
    if (blocks.some((b) => b.type === 'tool_result')) return false;
    content = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join(' ');
  }
  return typeof content === 'string' && !content.startsWith('<local-command') && !content.startsWith('[Request interrupted');
}

/** `<session>.jsonl` → `<session>/subagents/*.jsonl`, sorted. */
export function subagentFiles(transcript: string): string[] {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

interface Pass {
  byId: Map<string, { usage: Usage; model: string; eklavya: boolean }>;
  tools: Record<string, number>;
  toolErrors: number;
  models: Record<string, number>;
  anon: number;
}

/**
 * Reads one log's assistant usage and tool calls into `pass`. Returns the
 * agent types its `Agent`/`Task` calls started, by the agent id the result
 * named (the parent's own log only; how subagent files are attributed).
 */
function readLog(file: string, pass: Pass, head: Partial<TranscriptSummary> | null): { agentTypes: Map<string, string>; prompts: number; deferred: Set<string> } {
  const spawned = new Map<string, string>(); // tool_use id → subagent_type
  const agentTypes = new Map<string, string>(); // agent id → subagent_type
  const deferred = new Set<string>();
  let prompts = 0;
  for (const line of lines(file)) {
    const ev = parse(line);
    if (!ev) continue;
    if (head) {
      if (!head.sessionId && typeof ev.sessionId === 'string') head.sessionId = ev.sessionId;
      if (!head.cwd && typeof ev.cwd === 'string' && ev.cwd) head.cwd = ev.cwd;
      if (!head.version && typeof ev.version === 'string') head.version = ev.version;
      if (typeof ev.timestamp === 'string') {
        if (!head.startedAt) head.startedAt = ev.timestamp;
        head.endedAt = ev.timestamp;
      }
      const att = ev.attachment as Record<string, unknown> | undefined;
      if (att && att.type === 'deferred_tools_delta') {
        for (const n of Array.isArray(att.addedNames) ? att.addedNames : []) if (typeof n === 'string') deferred.add(n);
        for (const n of Array.isArray(att.removedNames) ? att.removedNames : []) if (typeof n === 'string') deferred.delete(n);
      }
      if (isPrompt(ev)) prompts++;
    }
    const msg = (ev.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
    if (ev.type === 'assistant') {
      let eklavya = false;
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        pass.tools[b.name] = (pass.tools[b.name] ?? 0) + 1;
        if (isEklavyaTool(b.name)) eklavya = true;
        const input = (b.input ?? {}) as Record<string, unknown>;
        if ((b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string' && typeof input.subagent_type === 'string') {
          spawned.set(b.id, input.subagent_type);
        }
      }
      const usage = usageOf(msg.usage);
      if (usage) {
        const model = typeof msg.model === 'string' && msg.model ? msg.model : 'unknown';
        let id = typeof msg.id === 'string' && msg.id ? msg.id : '';
        if (!id) id = `anon-${file}-${++pass.anon}`;
        const prev = pass.byId.get(id);
        // Later entries of the same message carry the final counts.
        pass.byId.set(id, { usage, model, eklavya: eklavya || Boolean(prev?.eklavya) });
        if (!prev) pass.models[model] = (pass.models[model] ?? 0) + 1;
      }
    } else if (ev.type === 'user') {
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.is_error === true) pass.toolErrors++;
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && spawned.has(b.tool_use_id)) {
          const result = (ev.toolUseResult ?? {}) as Record<string, unknown>;
          if (typeof result.agentId === 'string') agentTypes.set(result.agentId, spawned.get(b.tool_use_id)!);
        }
      }
    }
  }
  return { agentTypes, prompts, deferred };
}

const fresh = (): Pass => ({ byId: new Map(), tools: {}, toolErrors: 0, models: {}, anon: 0 });

function fold(pass: Pass, into: { usage: Usage; byModel: Record<string, Usage> }, only?: (r: { eklavya: boolean }) => boolean): void {
  for (const r of pass.byId.values()) {
    if (only && !only(r)) continue;
    addUsage(into.usage, r.usage);
    addUsage((into.byModel[r.model] ??= zeroUsage()), r.usage);
  }
}

/** Summarise a session's transcript and its subagents' logs. A missing file reads as an empty session. */
export function readTranscript(transcript: string): TranscriptSummary {
  const head: Partial<TranscriptSummary> = { sessionId: null, cwd: null, version: null, startedAt: null, endedAt: null };
  const main = fresh();
  const { agentTypes, prompts, deferred } = readLog(transcript, main, head);
  const out: TranscriptSummary = {
    sessionId: head.sessionId ?? null,
    cwd: head.cwd ?? null,
    version: head.version ?? null,
    startedAt: head.startedAt ?? null,
    endedAt: head.endedAt ?? null,
    requests: main.byId.size,
    usage: zeroUsage(),
    byModel: {},
    model: null,
    subagents: {},
    eklavya: { usage: zeroUsage(), byModel: {} },
    tools: { ...main.tools },
    toolErrors: main.toolErrors,
    prompts,
    deferredTools: [...deferred].sort(),
    files: fs.existsSync(transcript) ? 1 : 0,
  };
  fold(main, out);
  fold(main, out.eklavya, (r) => r.eklavya);
  const models = { ...main.models };
  for (const file of subagentFiles(transcript)) {
    out.files++;
    const sub = fresh();
    readLog(file, sub, null);
    const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
    const type = agentTypes.get(agentId) ?? 'unknown';
    fold(sub, out);
    fold(sub, (out.subagents[type] ??= { usage: zeroUsage(), byModel: {} }));
    out.requests += sub.byId.size;
    out.toolErrors += sub.toolErrors;
    for (const [name, n] of Object.entries(sub.tools)) out.tools[name] = (out.tools[name] ?? 0) + n;
    for (const [m, n] of Object.entries(sub.models)) models[m] = (models[m] ?? 0) + n;
  }
  out.model = Object.entries(models).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return out;
}

/** Where Claude Code keeps session logs: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function projectsDir(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
}

/** The folder Claude Code files a directory's sessions under: every non-alphanumeric becomes `-`. */
export const projectFolder = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-');

/** A session id that is safe in a file name (Claude Code's are UUIDs). */
export const safeSessionId = (sid: unknown): sid is string => typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sid);

/** The transcript of `sessionId`, looked up under the checkout's folder first, then every folder. */
export function findTranscript(projects: string, sessionId: string, cwd?: string | null): string | null {
  if (!safeSessionId(sessionId)) return null;
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = path.join(projects, projectFolder(cwd), name);
    if (fs.existsSync(direct)) return direct;
  }
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const file = path.join(projects, folder, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * A session's Bash and WebFetch calls with what came back, main thread only,
 * in order: what the environment-fact families read. Held in memory for the
 * fold and dropped; the facts keep only command forms, variable names and hosts.
 */
export function readCalls(transcript: string): { tool: string; input: string; output: string; failed: boolean }[] {
  const pending = new Map<string, { tool: string; input: string }>();
  const out: { tool: string; input: string; output: string; failed: boolean }[] = [];
  for (const line of lines(transcript)) {
    const ev = parse(line);
    if (!ev || ev.isSidechain) continue;
    const content = ((ev.message ?? {}) as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string' && (b.name === 'Bash' || b.name === 'WebFetch')) {
        pending.set(b.id, { tool: b.name, input: String((b.name === 'Bash' ? input.command : input.url) ?? '') });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && pending.has(b.tool_use_id)) {
        const c = b.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n') : '';
        out.push({ ...pending.get(b.tool_use_id)!, output: text.slice(0, 20_000), failed: b.is_error === true });
        pending.delete(b.tool_use_id);
      }
    }
  }
  return out;
}
