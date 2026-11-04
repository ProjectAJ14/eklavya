#!/usr/bin/env node
// Copies a Claude Code session transcript (and its subagent logs) into a test
// fixture, keeping only what mcp/src/economy/transcript.ts reads: line types,
// ids, models, usage, tool names, error flags, agent ids, deferred-tool names,
// the developer's prompts and Bash commands with their output. Every other
// string becomes "[scrubbed]", and the checkout and home paths are replaced.
//
//   node eval/scrub-transcript.mjs <session.jsonl> <out-dir> <checkout-dir>
//
// Writes <out-dir>/session.jsonl and <out-dir>/session/subagents/*.jsonl.
// Read the output before committing it: the allowlist is the safeguard, the
// path rewrite is not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [src, outDir, checkout] = process.argv.slice(2);
if (!src || !outDir || !checkout) {
  console.error('usage: scrub-transcript.mjs <session.jsonl> <out-dir> <checkout-dir>');
  process.exit(2);
}

const X = '[scrubbed]';
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const swaps = [
  [real(checkout), '/work/project'],
  [checkout, '/work/project'],
  [os.homedir(), '/home/dev'],
  [os.userInfo().username, 'dev'],
].sort((a, b) => b[0].length - a[0].length);
const user = os.userInfo().username;
const paths = (s) =>
  swaps
    .reduce((t, [from, to]) => t.split(from).join(to), s)
    // Temp roots, plain and in Claude Code's dash-encoded folder names.
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"'`\\)]*/g, '/tmp/work')
    .replace(/-(?:private-)?(?:tmp|var-folders)-[A-Za-z0-9_-]*/g, '-tmp-work')
    .split(`-Users-${user}-`).join('-home-dev-')
    .split(`-Users-dev-`).join('-home-dev-');
const short = (s) => paths(String(s).slice(0, 2000));

const ENVELOPE = ['type', 'uuid', 'parentUuid', 'isSidechain', 'isMeta', 'isCompactSummary', 'sessionId', 'version', 'timestamp', 'agentId', 'userType'];

function block(b, role, bashIds) {
  if (!b || typeof b !== 'object') return b;
  const out = { type: b.type };
  if (b.type === 'text') out.text = role === 'prompt' ? paths(b.text) : X;
  if (b.type === 'thinking') out.thinking = X;
  if (b.type === 'tool_use') {
    Object.assign(out, { id: b.id, name: b.name });
    const input = b.input ?? {};
    if (b.name === 'Bash') { out.input = { command: short(input.command ?? '') }; bashIds.add(b.id); }
    else if (b.name === 'Agent' || b.name === 'Task') out.input = { subagent_type: input.subagent_type, description: X, prompt: X };
    else out.input = {};
  }
  if (b.type === 'tool_result') {
    Object.assign(out, { tool_use_id: b.tool_use_id });
    if (b.is_error !== undefined) out.is_error = b.is_error;
    const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? '').join('\n') : '';
    out.content = bashIds.has(b.tool_use_id) ? short(text) : X;
  }
  return out;
}

function line(ev, bashIds) {
  const out = {};
  for (const k of ENVELOPE) if (ev[k] !== undefined) out[k] = ev[k];
  if (typeof ev.cwd === 'string') out.cwd = paths(ev.cwd);
  if (ev.attachment && typeof ev.attachment === 'object') {
    const a = { type: ev.attachment.type };
    if (a.type === 'deferred_tools_delta') {
      a.addedNames = ev.attachment.addedNames ?? [];
      a.removedNames = ev.attachment.removedNames ?? [];
    }
    out.attachment = a;
  }
  if (ev.toolUseResult && typeof ev.toolUseResult === 'object' && typeof ev.toolUseResult.agentId === 'string') {
    out.toolUseResult = { agentId: ev.toolUseResult.agentId };
  }
  const m = ev.message;
  if ((ev.type === 'user' || ev.type === 'assistant') && m && typeof m === 'object') {
    const msg = {};
    for (const k of ['id', 'role', 'model', 'usage', 'stop_reason']) if (m[k] !== undefined) msg[k] = m[k];
    const prompt = ev.type === 'user' && !ev.isMeta && !ev.isSidechain;
    if (typeof m.content === 'string') msg.content = prompt ? paths(m.content) : X;
    else if (Array.isArray(m.content)) msg.content = m.content.map((b) => block(b, prompt ? 'prompt' : ev.type, bashIds));
    out.message = msg;
  }
  return out;
}

function scrub(from, to) {
  const bashIds = new Set();
  const text = fs.readFileSync(from, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.stringify(line(JSON.parse(l), bashIds)); } catch { return null; } })
    .filter(Boolean).join('\n') + '\n';
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text);
}

scrub(src, path.join(outDir, 'session.jsonl'));
const subs = path.join(src.replace(/\.jsonl$/, ''), 'subagents');
if (fs.existsSync(subs)) {
  for (const f of fs.readdirSync(subs).filter((f) => f.endsWith('.jsonl'))) {
    scrub(path.join(subs, f), path.join(outDir, 'session', 'subagents', f));
  }
}
