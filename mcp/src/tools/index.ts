import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DB } from '../db.js';

/**
 * Phase 0 registers the full tool surface with real input schemas but stub
 * handlers, so `tools/list` is correct and Phase 1 only has to fill in logic.
 * Phase 1 splits these into one file per tool (PRD §6 layout).
 */

const conceptRef = z.object({
  slug: z.string().describe('kebab-case concept slug'),
  name: z.string().optional(),
  domain: z.string().optional(),
  tier: z.number().int().min(1).max(5).optional(),
  context: z.string().optional().describe('one line pointing at the actual code this touched'),
});

const edgeRef = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.enum(['prerequisite_of', 'related_to', 'part_of']),
});

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_learner_profile',
    title: 'Get learner profile',
    description:
      'What this developer already knows. Call before teaching or quizzing so you never ask about a mastered concept. Returns mode, per-domain counts, weak concepts, and what is due for review.',
    inputSchema: { domain: z.string().optional() },
  },
  {
    name: 'log_session_concepts',
    title: 'Log session concepts',
    description:
      'Record the concepts the current task genuinely exercises, each with a one-line context pointing at the real code. Call this while implementing, batched, 3-8 concepts per task.',
    inputSchema: {
      session_id: z.string(),
      concepts: z.array(conceptRef).min(1),
    },
  },
  {
    name: 'get_session_quiz_plan',
    title: 'Get session quiz plan',
    description:
      'What to quiz on right now, at what difficulty tier, based on this session\'s concepts and what is due for review.',
    inputSchema: {
      session_id: z.string(),
      max: z.number().int().min(1).max(10).optional(),
    },
  },
  {
    name: 'record_attempt',
    title: 'Record a quiz attempt',
    description:
      'Grade one answer on the 0-5 SM-2 scale and persist it. Updates mastery, the next review date, and the session gate. Record skips too, as grade 0.',
    inputSchema: {
      session_id: z.string(),
      slug: z.string(),
      question: z.string(),
      answer: z.string().optional(),
      grade: z.number().int().min(0).max(5),
      difficulty: z.number().int().min(1).max(5),
      feedback: z.string().optional(),
    },
  },
  {
    name: 'get_gate_status',
    title: 'Get gate status',
    description: 'Whether this session has passed its quiz gate (enforced mode blocks commits until it has).',
    inputSchema: { session_id: z.string() },
  },
  {
    name: 'upsert_concepts',
    title: 'Upsert concepts',
    description:
      'Grow the knowledge graph when work touches a concept that has no slug yet. Slugs are normalized and fuzzy-matched against existing ones before insert.',
    inputSchema: {
      concepts: z.array(conceptRef).min(1),
      edges: z.array(edgeRef).optional(),
    },
  },
  {
    name: 'get_concept_graph',
    title: 'Get concept graph',
    description: 'Concepts and edges for a domain, prerequisite-ordered, optionally with mastery state.',
    inputSchema: {
      domain: z.string(),
      include_mastery: z.boolean().optional(),
    },
  },
  {
    name: 'get_config',
    title: 'Get config',
    description: 'Effective Eklavya config: global ~/.eklavya/config.json merged with the repo .eklavya.json, repo winning.',
    inputSchema: { cwd: z.string().optional() },
  },
  {
    name: 'set_config',
    title: 'Set config',
    description: 'Update Eklavya config: mode, pass threshold, questions per task, quiet.',
    inputSchema: {
      scope: z.enum(['global', 'repo']).optional(),
      cwd: z.string().optional(),
      mode: z.enum(['ambient', 'enforced', 'off']).optional(),
      pass_threshold: z.number().min(0).max(1).optional(),
      max_questions_per_task: z.number().int().min(1).max(10).optional(),
      min_minutes_between_quizzes: z.number().int().min(0).optional(),
      quiet: z.boolean().optional(),
    },
  },
];

function notImplemented(name: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'not_implemented',
          tool: name,
          detail: 'Eklavya is at Phase 0 (scaffold). Tool logic lands in Phase 1.',
        }),
      },
    ],
    isError: true,
  };
}

export function registerTools(server: McpServer, _db: DB): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async () => notImplemented(tool.name),
    );
  }
}
