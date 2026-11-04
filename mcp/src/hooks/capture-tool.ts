/**
 * PostToolUse (every tool) and PostToolUseFailure: record what the agent just did.
 *
 * This is the memory half's main intake. It matches every tool rather than one,
 * so it is the hook that runs most often in a session — which is why it does
 * the least: resolve identity, normalise one event, one insert, exit.
 *
 * It deliberately does not quiz, summarise, or call a provider. The checkpoint
 * hook owns questions and the seam owns summaries; a capture path that also
 * teaches is a capture path that makes every tool call slower.
 */
import { run, openExisting, config, cwdOf, sessionId } from './lib.js';
import type { DB, HookInput } from './lib.js';
import type { EklavyaConfig } from '../config.js';
import { foldCall, type GuardOutput } from '../loop-guard.js';
import { economyOff, runtimeCliPath } from './economy-lib.js';
import { startDetached } from '../ledger-pending.js';
import { batchIfFull, identityOf, record } from './capture-lib.js';
import { policyFrom, type HostEvent } from '../memory/capture.js';
import { clip, clipTail, type PrivacyPolicy } from '../memory/privacy.js';

/** Tools whose result is a file's contents rather than a change to one. */
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function filesFrom(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return [];
  const candidates = [toolInput.file_path, toolInput.notebook_path, toolInput.path];
  return candidates.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/** Tools whose result is not worth keeping: a file's contents, or an edit's echo. */
const NO_RESULT = new Set(['Read', 'NotebookRead', ...EDIT_TOOLS]);

/** Most of a result a single event keeps; `MAX_BODY` still caps the whole body. */
const RESULT_HEAD = 1_600;
const RESULT_TAIL = 600;

/**
 * The text of a tool's result, whatever shape the host sent: a string, content
 * blocks (MCP), `stdout`/`stderr` (Bash), or a known text field.
 */
function resultText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    return response
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!response || typeof response !== 'object') return '';
  const r = response as Record<string, unknown>;
  const std = [r.stdout, r.stderr].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (std.length) return std.join('\n');
  for (const key of ['content', 'result', 'output', 'text']) {
    const v = r[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return resultText(v);
  }
  if (Array.isArray(r.filenames)) return (r.filenames as unknown[]).map(String).join('\n');
  return '';
}

/**
 * What the result showed, head and tail — the tail is where a test summary or
 * a stack trace ends up. This is what an observation is made from: without it
 * the summariser saw that `git log` ran, never what it showed, and could record
 * that work happened but not what was found. Each piece is redacted before it
 * is cut, over a bounded window: a cut first could leave half a secret that the
 * redaction of the stored body no longer recognises.
 */
function excerpt(tool: string, response: unknown, policy: PrivacyPolicy): string {
  if (NO_RESULT.has(tool)) return '';
  const text = resultText(response).trim();
  if (!text) return '';
  if (text.length <= RESULT_HEAD + RESULT_TAIL) return text;
  return `${clip(text, RESULT_HEAD, policy)}\n…\n${clipTail(text, RESULT_TAIL, policy)}`;
}

/**
 * What the event's body says: the arguments, then what came back.
 *
 * A failure keeps its message. A success keeps an excerpt of its result, except
 * for reads and edits: a `Read` returning a whole file would make the corpus a
 * second copy of the repository, and an edit's result only echoes its input.
 */
function bodyFor(input: HookInput, failed: boolean, policy: PrivacyPolicy): string {
  const toolInput = input.tool_input ?? {};
  const parts: string[] = [];
  if (typeof toolInput.command === 'string') parts.push(toolInput.command);
  if (typeof toolInput.description === 'string') parts.push(toolInput.description);
  if (typeof toolInput.prompt === 'string') parts.push(toolInput.prompt);
  if (typeof toolInput.old_string === 'string' && typeof toolInput.new_string === 'string') {
    parts.push(`- ${clip(toolInput.old_string, 600, policy)}`, `+ ${clip(toolInput.new_string, 600, policy)}`);
  }
  if (!parts.length) {
    const keys = Object.keys(toolInput).filter((k) => k !== 'content');
    // JSON for anything that is not a string: `String()` of an object is
    // "[object Object]", which is how every AskUserQuestion was remembered as
    // `questions=[object Object] answers=[object Object]`.
    const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
    if (keys.length) parts.push(keys.map((k) => `${k}=${clip(text(toolInput[k]), 200, policy)}`).join(' '));
  }
  if (failed) parts.push(clip(errorText(input), 800, policy));
  else {
    const result = excerpt(input.tool_name!, input.tool_response, policy);
    if (result) parts.push(`→ ${result}`);
  }
  return parts.join('\n');
}

/**
 * The failure's message: `PostToolUseFailure` sends it as `error`; a failed
 * `PostToolUse` response carries it in `error` or `stderr`.
 */
function errorText(input: HookInput): string {
  if (input.hook_event_name === 'PostToolUseFailure') {
    const text = typeof input.error === 'string' ? input.error : JSON.stringify(input.error ?? '');
    return input.is_interrupt ? `(interrupted) ${text}` : text;
  }
  const r = input.tool_response as Record<string, unknown>;
  if (typeof r.error === 'string') return r.error;
  if (typeof r.stderr === 'string') return r.stderr;
  return '';
}

/** A `PostToolUseFailure` event, or a `PostToolUse` whose response says it failed. */
function failed(input: HookInput): boolean {
  if (input.hook_event_name === 'PostToolUseFailure') return true;
  const response = input.tool_response;
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  return r.success === false || Boolean(r.error) || r.is_error === true;
}

function kindFor(tool: string, isError: boolean): HostEvent['kind'] {
  if (isError) return 'tool_error';
  if (EDIT_TOOLS.has(tool)) return 'file_edit';
  if (READ_TOOLS.has(tool)) return 'file_read';
  return 'tool_use';
}

/** The guard's view of the call: its result text, and whether the host said it failed. */
function guardCall(db: DB, config: EklavyaConfig, input: HookInput, sid: string, tool: string): GuardOutput {
  try {
    const isFailure = input.hook_event_name === 'PostToolUseFailure';
    const result = isFailure ? errorText(input) : resultText(input.tool_response);
    const response = input.tool_response as Record<string, unknown> | undefined;
    const hostFailed = isFailure || failed(input) ? true : response && typeof response === 'object' && 'success' in response ? false : null;
    return foldCall(db, config, {
      sessionId: sid,
      agentId: input.agent_id ?? null,
      tool,
      args: input.tool_input ?? {},
      result,
      failed: hostFailed,
      headless: process.env.CLAUDE_CODE_SESSION_ATTENDED === '0',
      toolUseId: typeof input.tool_use_id === 'string' && input.tool_use_id ? input.tool_use_id : null,
    });
  } catch {
    return {};
  }
}

await run(async (input) => {
  const db = openExisting();
  if (!db) return 0;

  const cwd = cwdOf(input);
  const resolved = config(cwd);
  const tool = input.tool_name ?? '';
  if (!tool) return 0;

  const sid = sessionId(input, db);
  // The loop guard folds every call, memory or not (issue #262). Whatever it
  // has to say leaves as this hook's one output.
  const guard = sid && resolved.config.economy.loopguard !== 'off' && !economyOff() ? guardCall(db, resolved.config, input, sid, tool) : {};
  // The judge is a model call: a detached process, never awaited.
  if (guard.judgeTurn) startDetached(runtimeCliPath(), ['judge', String(guard.judgeTurn)]);
  if (guard.stop) process.stdout.write(`${JSON.stringify({ continue: false, stopReason: guard.stop })}\n`);
  else if (guard.context) {
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolUse', additionalContext: guard.context } })}\n`,
    );
  }

  const identity = identityOf(input, cwd, sid);
  // Capture is independent of `mode`: someone who turned quizzing off did not
  // ask for their project history to stop being recorded (PRD CFG-01).
  if (!resolved.config.memory.enabled) return 0;

  const isError = failed(input);
  const body = bodyFor(input, isError, policyFrom(resolved.config));
  if (!body.trim()) return 0;

  record(db, resolved, identity, {
    kind: kindFor(tool, isError),
    tool,
    title: tool,
    body,
    files: filesFrom(input.tool_input),
    // One failure is one event: `PostToolUse` with a failed response and
    // `PostToolUseFailure` for the same call share this id.
    hostId: isError && typeof input.tool_use_id === 'string' && input.tool_use_id ? `${input.tool_use_id}` : null,
  });
  batchIfFull(db, resolved, identity);
  return 0;
});
