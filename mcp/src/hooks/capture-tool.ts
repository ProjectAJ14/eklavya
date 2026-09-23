/**
 * PostToolUse (every tool): record what the agent just did.
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
import type { HookInput } from './lib.js';
import { batchIfFull, identityOf, record } from './capture-lib.js';
import type { HostEvent } from '../memory/capture.js';

/** Tools whose result is a file's contents rather than a change to one. */
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

function filesFrom(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return [];
  const candidates = [toolInput.file_path, toolInput.notebook_path, toolInput.path];
  return candidates.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/**
 * What the event's body says.
 *
 * Arguments rather than results, with one exception: a failure's message is the
 * part worth remembering. A successful `Read` returning a whole file would make
 * the corpus a second copy of the repository.
 */
function bodyFor(input: HookInput, failed: boolean): string {
  const toolInput = input.tool_input ?? {};
  const parts: string[] = [];
  if (typeof toolInput.command === 'string') parts.push(toolInput.command);
  if (typeof toolInput.description === 'string') parts.push(toolInput.description);
  if (typeof toolInput.prompt === 'string') parts.push(toolInput.prompt);
  if (typeof toolInput.old_string === 'string' && typeof toolInput.new_string === 'string') {
    parts.push(`- ${toolInput.old_string.slice(0, 600)}`, `+ ${toolInput.new_string.slice(0, 600)}`);
  }
  if (!parts.length) {
    const keys = Object.keys(toolInput).filter((k) => k !== 'content');
    // JSON for anything that is not a string: `String()` of an object is
    // "[object Object]", which is how every AskUserQuestion was remembered as
    // `questions=[object Object] answers=[object Object]`.
    const text = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));
    if (keys.length) parts.push(keys.map((k) => `${k}=${text(toolInput[k]).slice(0, 200)}`).join(' '));
  }
  if (failed) parts.push(String(errorText(input.tool_response)).slice(0, 800));
  return parts.join('\n');
}

function errorText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.error === 'string') return r.error;
    if (typeof r.stderr === 'string') return r.stderr;
  }
  return '';
}

function failed(response: unknown): boolean {
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

await run(async (input) => {
  const db = openExisting();
  if (!db) return 0;

  const cwd = cwdOf(input);
  const resolved = config(cwd);
  // Capture is independent of `mode`: someone who turned quizzing off did not
  // ask for their project history to stop being recorded (PRD CFG-01).
  if (!resolved.config.memory.enabled) return 0;

  const tool = input.tool_name ?? '';
  if (!tool) return 0;

  const sid = sessionId(input, db);
  const identity = identityOf(input, cwd, sid);
  const isError = failed(input.tool_response);
  const body = bodyFor(input, isError);
  if (!body.trim()) return 0;

  record(db, resolved, identity, {
    kind: kindFor(tool, isError),
    tool,
    title: tool,
    body,
    files: filesFrom(input.tool_input),
  });
  batchIfFull(db, resolved, identity);
  return 0;
});
