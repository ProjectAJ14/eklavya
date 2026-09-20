import { z } from 'zod';
import path from 'node:path';
import { loadConfig, writeConfigFile, REPO_CONFIG_FILE, DEFAULT_CONFIG } from '../config.js';
import { currentSurface } from '../surface.js';
import { FALLBACK_SESSION_ID, isSessionOff, resolveSessionId, setSessionOff } from '../session.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const getConfig: ToolDef = {
  name: 'get_config',
  title: 'Get config',
  description:
    'The effective Eklavya config: global ~/.eklavya/config.json merged with the repo .eklavya.json, repo winning. Also reports surface — "code" for Claude Code (a terminal or the Code tab in Claude Desktop) or "cowork" — which is the only reliable way to tell: in Cowork a shell command runs in a sandbox VM and cannot see the host environment this is read from.',
  inputSchema: {
    cwd: z.string().optional().describe(CWD_HINT),
    session_id: z.string().optional().describe(SESSION_HINT),
  },
  handler: (args: { cwd?: string; session_id?: string }, ctx) => {
    const resolved = loadConfig(args.cwd);
    const session = resolveSessionId(ctx.db, args.session_id);
    return {
      config: resolved.config,
      /**
       * Whether this one session has been silenced with `scope: "session"`.
       * Reported next to `config` because it is not in either config file and
       * would otherwise be invisible: a session that is off looks identically
       * configured to one that is not.
       */
      session_off: isSessionOff(ctx.db, session),
      session_id: session,
      global_path: resolved.globalPath,
      repo_path: resolved.repoPath,
      repo_root: resolved.repoRoot,
      /**
       * Which Claude surface this is. Reported here because the server is the
       * one part of Eklavya that runs on the host in every case: Cowork
       * executes shell commands inside a sandbox VM, so a skill that tried to
       * read `CLAUDE_CODE_ENTRYPOINT` with `echo` would be reading the VM's
       * environment and getting the wrong answer, or nothing at all.
       */
      surface: currentSurface(),
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
    'Update Eklavya config. Scope "global" writes ~/.eklavya/config.json; scope "repo" writes .eklavya.json at the repo root, which is how a team lead pins enforced mode — or a difficulty level — for one project. Scope "session" writes no file at all: it takes only `mode`, silences this one session when that is "off", and un-silences it for any other value. Use it whenever someone asks to turn Eklavya off "for now" or "for this session" — writing off to a file instead leaves the tool off long after the afternoon that needed it.',
  inputSchema: {
    scope: z
      .enum(['global', 'repo', 'session'])
      .optional()
      .describe('Defaults to global. "session" lasts until this session ends and takes only mode.'),
    cwd: z.string().optional().describe(CWD_HINT),
    session_id: z.string().optional().describe(SESSION_HINT),
    mode: z
      .enum(['ambient', 'enforced', 'off'])
      .optional()
      .describe('How hard Eklavya pushes: ambient offers, enforced gates commits, off is dormant.'),
    focus: z
      .enum(['project', 'concept', 'learn'])
      .optional()
      .describe(
        'What Eklavya teaches, independent of mode. "project" quizzes the code just written; "concept" asks the transferable version of the same ideas; "learn" follows focus_topic. Defaults to concept.',
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
  handler: (args: Record<string, unknown>, ctx) => {
    const scope = (args.scope as 'global' | 'repo' | 'session' | undefined) ?? 'global';
    const cwd = args.cwd as string | undefined;
    const resolved = loadConfig(cwd);

    // Derived from DEFAULT_CONFIG rather than hand-listed. A hand-listed copy is a
    // second place a new key has to be added, and forgetting it is invisible:
    // the schema accepts the key, the tool reports success, and the setting is
    // silently dropped on the floor. `scope` and `cwd` are not config keys, so
    // they cannot leak into the file.
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (args[key] !== undefined) patch[key] = args[key];
    }

    if (Object.keys(patch).length === 0) {
      return { error: 'nothing_to_set', detail: 'Pass at least one setting to change.' };
    }

    if (scope === 'session') {
      // Only `mode` is session-scoped. The rest are settings, not an
      // interruption someone wants to stop right now, and a per-session
      // `difficulty` that vanished at the end of the day would be a dial that
      // silently un-set itself.
      const extra = Object.keys(patch).filter((key) => key !== 'mode');
      if (extra.length > 0 || patch.mode === undefined) {
        return {
          error: 'session_scope_is_mode_only',
          detail: 'Scope "session" takes only mode: "off" to silence this session, any other value to bring it back. Everything else needs global or repo scope.',
        };
      }

      const session = resolveSessionId(ctx.db, args.session_id as string | undefined);

      // No real session id to key on. `resolveSessionId` falls back to the
      // literal "default" when no SessionStart hook has ever run — Cursor
      // through `export-rules`, a host without hooks — and a row under that key
      // silences every future session that lands on the same fallback, with no
      // file to notice and no session end to clear it. Refusing is the whole
      // point of a switch whose promise is that it forgets by itself.
      if (session === FALLBACK_SESSION_ID) {
        return {
          error: 'no_session',
          detail:
            'No Claude Code session is registered, so there is nothing to scope this to — the hooks are what stamp the session id, and they have not run. Use scope "global" (and set mode back afterwards) or pass session_id explicitly.',
        };
      }

      const off = patch.mode === 'off';
      setSessionOff(ctx.db, session, off);

      return {
        scope,
        session_id: session,
        session_off: off,
        // The file-backed mode is untouched, so say what it still is: turning a
        // session back on restores this, not whatever was passed here.
        config: resolved.config,
        // Honest about the one thing a session cannot turn off. The git
        // pre-commit hook reads .eklavya.json and never sees a session id, so a
        // silenced session in an enforced repo still meets the gate at commit.
        note:
          off && resolved.config.mode === 'enforced'
            ? 'Questions are silenced for this session, but the repo is in enforced mode and the commit gate still holds — and it keeps growing, because work logged while you are silent still counts toward it. The quiz has to happen before a commit lands.'
            : undefined,
      };
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
