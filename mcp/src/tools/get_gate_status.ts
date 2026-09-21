import { z } from 'zod';
import { loadConfig } from '../config.js';
import { resolveSessionId } from '../session.js';
import { syncGate } from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const getGateStatus: ToolDef = {
  name: 'get_gate_status',
  title: 'Get gate status',
  // "on a surface that commits" rather than a flat claim: the gate matches
  // `git commit`, so in Cowork it records everything below and blocks nothing.
  // Said here because this description is what the model repeats back when a
  // learner asks why they are being quizzed.
  description:
    'Whether this session has passed its quiz gate. In enforced mode, on a surface that commits, commits stay blocked until it has — Cowork does not commit, so there the gate records but never blocks. `required` is how many of this session\'s unmastered concepts count, `needed` is how many of those must be passed (ceil(required * pass_threshold)), and `passed_count` is how many are passed so far -- `needed - passed_count` is exactly what remains. `answered` counts every concept attempted, review debt included, so it can exceed `passed_count`.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { session_id?: string; cwd?: string }, { db }) => {
    const { config, repoRoot } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id, args.cwd);
    return { session_id: sessionId, ...syncGate(db, sessionId, config, { repo: repoRoot }) };
  },
};
