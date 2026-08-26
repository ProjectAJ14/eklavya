import { z } from 'zod';
import path from 'node:path';
import { loadConfig, writeConfigFile, REPO_CONFIG_FILE } from '../config.js';
import { CWD_HINT, type ToolDef } from './types.js';

export const getConfig: ToolDef = {
  name: 'get_config',
  title: 'Get config',
  description:
    'The effective Eklavya config: global ~/.eklavya/config.json merged with the repo .eklavya.json, repo winning.',
  inputSchema: { cwd: z.string().optional().describe(CWD_HINT) },
  handler: (args: { cwd?: string }) => {
    const resolved = loadConfig(args.cwd);
    return {
      config: resolved.config,
      global_path: resolved.globalPath,
      repo_path: resolved.repoPath,
      repo_root: resolved.repoRoot,
    };
  },
};

export const setConfig: ToolDef = {
  name: 'set_config',
  title: 'Set config',
  description:
    'Update Eklavya config. Scope "global" writes ~/.eklavya/config.json; scope "repo" writes .eklavya.json at the repo root, which is how a team lead pins enforced mode for one project.',
  inputSchema: {
    scope: z.enum(['global', 'repo']).optional().describe('Defaults to global.'),
    cwd: z.string().optional().describe(CWD_HINT),
    mode: z.enum(['ambient', 'enforced', 'off']).optional(),
    pass_threshold: z.number().min(0).max(1).optional(),
    max_questions_per_task: z.number().int().min(1).max(10).optional(),
    min_minutes_between_quizzes: z.number().int().min(0).optional(),
    max_new_concepts_per_session: z.number().int().min(0).max(50).optional(),
    max_stop_blocks_per_session: z.number().int().min(0).max(20).optional(),
    quiet: z.boolean().optional(),
    domains_enabled: z.array(z.string()).optional(),
  },
  handler: (args: Record<string, unknown>) => {
    const scope = (args.scope as 'global' | 'repo' | undefined) ?? 'global';
    const cwd = args.cwd as string | undefined;
    const resolved = loadConfig(cwd);

    const patch: Record<string, unknown> = {};
    for (const key of [
      'mode',
      'pass_threshold',
      'max_questions_per_task',
      'min_minutes_between_quizzes',
      'max_new_concepts_per_session',
      'max_stop_blocks_per_session',
      'quiet',
      'domains_enabled',
    ]) {
      if (args[key] !== undefined) patch[key] = args[key];
    }

    if (Object.keys(patch).length === 0) {
      return { error: 'nothing_to_set', detail: 'Pass at least one setting to change.' };
    }

    let target: string;
    if (scope === 'repo') {
      const root = resolved.repoRoot;
      if (!root) {
        return {
          error: 'no_repo_root',
          detail: 'No git repository found from this directory, so there is nowhere to write .eklavya.json.',
        };
      }
      target = resolved.repoPath ?? path.join(root, REPO_CONFIG_FILE);
    } else {
      target = resolved.globalPath;
    }

    writeConfigFile(target, patch);

    return { written_to: target, scope, config: loadConfig(cwd).config };
  },
};
