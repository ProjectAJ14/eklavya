import { z } from 'zod';
import { loadConfig } from '../config.js';
import { resolveSessionId } from '../session.js';
import { syncGate } from '../store.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const getGateStatus: ToolDef = {
  name: 'get_gate_status',
  title: 'Get gate status',
  description:
    'Whether this session has passed its quiz gate. In enforced mode commits stay blocked until it has. `required` is how many of this session\'s unmastered concepts count, `needed` is how many of those must be passed (ceil(required * pass_threshold)), and `passed_count` is how many are passed so far -- `needed - passed_count` is exactly what remains. `answered` counts every concept attempted, review debt included, so it can exceed `passed_count`.',
  inputSchema: {
    session_id: z.string().optional().describe(SESSION_HINT),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { session_id?: string; cwd?: string }, { db }) => {
    const { config, repoRoot } = loadConfig(args.cwd);
    const sessionId = resolveSessionId(db, args.session_id);
    return { session_id: sessionId, ...syncGate(db, sessionId, config, { repo: repoRoot }) };
  },
};
