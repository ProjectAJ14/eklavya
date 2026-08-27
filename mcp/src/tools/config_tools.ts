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
      // Which of the learner's own settings this repo is overriding. Say it
      // rather than let a personal focus silently stop applying.
      overridden_by_repo: resolved.overrides,
    };
  },
};

export const setConfig: ToolDef = {
  name: 'set_config',
  title: 'Set config',
  description:
    'Update Eklavya config. Scope "global" writes ~/.eklavya/config.json; scope "repo" writes .eklavya.json at the repo root, which is how a team lead pins enforced mode — or a difficulty level — for one project.',
  inputSchema: {
    scope: z.enum(['global', 'repo']).optional().describe('Defaults to global.'),
    cwd: z.string().optional().describe(CWD_HINT),
    mode: z
      .enum(['ambient', 'enforced', 'off'])
      .optional()
      .describe('How hard Eklavya pushes: ambient offers, enforced gates commits, off is dormant.'),
    focus: z
      .enum(['project', 'concept', 'learn'])
      .optional()
      .describe(
        'What Eklavya teaches, independent of mode. "project" quizzes the code just written; "concept" asks the transferable version of the same ideas; "learn" follows focus_topic. Defaults to project.',
      ),
    cadence: z
      .enum(['interleaved', 'end'])
      .optional()
      .describe(
        'When the questions land. "interleaved" (default) asks one question mid-task, at the seam where a concept was logged, and the Stop hook then only sweeps up what is left of max_questions_per_task. "end" is the old behaviour: nothing until the task is finished.',
      ),
    min_minutes_between_checkpoints: z.number().int().min(0).max(120).optional(),
    difficulty: z
      .enum(['auto', 'easy', 'medium', 'hard'])
      .optional()
      .describe(
        'How hard questions on a project may get. "auto" (default) earns the level per project: everyone starts at easy (tiers 1-2), then medium (2-4), then hard (3-5). A literal level pins it and stops progression — "easy" on a repo keeps an onboarding codebase gentle for everyone, "hard" globally skips the runway.',
      ),
    level_up_after: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Passing answers needed at a level, in one project, before it promotes. Defaults to 100.'),
    level_up_accuracy: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Minimum accuracy over those answers, declines excluded. Defaults to 0.7.'),
    focus_topic: z
      .string()
      .nullable()
      .optional()
      .describe('The topic "learn" focus teaches, e.g. "caching". Pass null to clear it.'),
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
      'focus',
      'focus_topic',
      'cadence',
      'difficulty',
      'level_up_after',
      'level_up_accuracy',
      'min_minutes_between_checkpoints',
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
