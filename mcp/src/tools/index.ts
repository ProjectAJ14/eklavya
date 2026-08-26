import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DB } from '../db.js';
import type { ToolDef } from './types.js';
import { retryOnBusy } from '../concurrency.js';

import { getLearnerProfile } from './get_learner_profile.js';
import { logSessionConcepts } from './log_session_concepts.js';
import { getSessionQuizPlan } from './get_session_quiz_plan.js';
import { recordAttempt } from './record_attempt.js';
import { getGateStatus } from './get_gate_status.js';
import { upsertConcepts } from './upsert_concepts.js';
import { getConceptGraph } from './get_concept_graph.js';
import { getConfig, setConfig } from './config_tools.js';

export const TOOLS: ToolDef[] = [
  getLearnerProfile,
  logSessionConcepts,
  getSessionQuizPlan,
  recordAttempt,
  getGateStatus,
  upsertConcepts,
  getConceptGraph,
  getConfig,
  setConfig,
];

/** Tool results are JSON text: compact, and small enough to live in context (decision G7). */
function toResult(payload: unknown) {
  const text = JSON.stringify(payload);
  const isError = typeof payload === 'object' && payload !== null && 'error' in payload;
  return { content: [{ type: 'text' as const, text }], isError };
}

export function registerTools(server: McpServer, db: DB): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => {
        try {
          // Safe to retry: a busy transaction has already rolled back.
          return toResult(retryOnBusy(() => tool.handler(args, { db })));
        } catch (err) {
          // A tool throwing must not take the server down mid-session.
          return toResult({
            error: 'tool_failed',
            tool: tool.name,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  }
}
