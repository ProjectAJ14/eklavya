#!/usr/bin/env node
/**
 * The seam between the Python pilot and the TypeScript evaluator.
 *
 * GEPA is Python; Eklavya's question checks and judge wording are not. Rather
 * than port them (two copies drift), the pilot calls this with one JSON object
 * on stdin and reads one JSON object from stdout:
 *
 *   score        {question, answer_position, tier_to_ask}  -> deterministic verdicts
 *   audit-prompt {question, item}                          -> the audit judge's prompt
 *   cold-prompt  {question}                                -> the cold-read judge's prompt
 *   extract      {text}                                    -> the last JSON object in a reply
 *
 * `question` is {slug, stem, options[4], descriptions[4]?, correct (1-4)}.
 * Needs `mcp/dist` (cd mcp && npm run build).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditPrompt, coldPrompt } from '../judge-prompts.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (rel) => import(pathToFileURL(path.join(repoRoot, 'mcp', 'dist', rel)).href);

const words = (t) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

async function score({ question: q, answer_position, tier_to_ask }) {
  const { checkQuestion, strictlyLongest, visibleOptionProblem } = await dist('eval/question-checks.js');
  const checks = checkQuestion({
    fixture: 'pilot',
    slug: q.slug,
    tier_to_ask,
    answer_position,
    stem: q.stem,
    options: q.options,
    descriptions: q.descriptions,
    correct: q.correct,
  });
  const visible = q.options.map((o, i) => `${o} ${q.descriptions?.[i] ?? ''}`);
  const i = q.correct - 1;
  const inRange = Number.isInteger(q.correct) && q.correct >= 1 && q.correct <= q.options.length;
  const hasDesc = Array.isArray(q.descriptions) && q.descriptions.length === q.options.length;
  return {
    checks,
    visible_problem: visibleOptionProblem(q.options.map((label, k) => ({ label, description: q.descriptions?.[k] }))),
    visible_words: visible.map(words),
    label_words: q.options.map(words),
    // Longest-ness of the keyed option, three ways, for the sequence-level report.
    longest: inRange
      ? {
          label: strictlyLongest(q.options, i),
          description: hasDesc ? strictlyLongest(q.descriptions, i) : null,
          combined: strictlyLongest(visible, i),
        }
      : null,
  };
}

const cmds = {
  score,
  'audit-prompt': async ({ question, item }) => ({ prompt: auditPrompt(question, item) }),
  'cold-prompt': async ({ question }) => ({ prompt: coldPrompt(question) }),
  extract: async ({ text }) => ({ value: (await dist('eval/extract-json.js')).extractJson(text) ?? null }),
};

const cmd = process.argv[2];
if (!cmds[cmd]) {
  process.stderr.write(`usage: bridge.mjs ${Object.keys(cmds).join('|')} < input.json\n`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(await cmds[cmd](JSON.parse(fs.readFileSync(0, 'utf8')))));
