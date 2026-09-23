import { z } from 'zod';
import path from 'node:path';
import {
  loadConfig,
  writeConfigFile,
  readConfigFile,
  mainRepoRoot,
  isGlobalOnlyKey,
  DEFAULT_CONFIG,
} from '../config.js';
import { UnreadableFileError } from '../safe-write.js';
import { currentSurface } from '../surface.js';
import { FALLBACK_SESSION_ID, isSessionOff, resolveSessionId, setSessionOff } from '../session.js';
import { CWD_HINT, SESSION_HINT, type ToolDef } from './types.js';

export const getConfig: ToolDef = {
  name: 'get_config',
  title: 'Get config',
  description:
    'The effective Eklavya config: global ~/.eklavya/config.json merged with this project\'s ~/.eklavya/projects/<checkout>/config.json, the project winning. Nothing Eklavya configures lives inside the checkout — settings are per developer, not committed. Also reports surface — "code" for Claude Code (a terminal or the Code tab in Claude Desktop) or "cowork" — which is the only reliable way to tell: in Cowork a shell command runs in a sandbox VM and cannot see the host environment this is read from.',
  inputSchema: {
    cwd: z.string().optional().describe(CWD_HINT),
    session_id: z.string().optional().describe(SESSION_HINT),
  },
  handler: (args: { cwd?: string; session_id?: string }, ctx) => {
    const resolved = loadConfig(args.cwd);
    const session = resolveSessionId(ctx.db, args.session_id, args.cwd);
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
      project_path: resolved.projectPath,
      repo_root: resolved.repoRoot,
      /**
       * Which Claude surface this is. Reported here because the server is the
       * one part of Eklavya that runs on the host in every case: Cowork
       * executes shell commands inside a sandbox VM, so a skill that tried to
       * read `CLAUDE_CODE_ENTRYPOINT` with `echo` would be reading the VM's
       * environment and getting the wrong answer, or nothing at all.
       */
      surface: currentSurface(),
      // Which of the learner's own global settings this project is overriding. Say it
      // rather than let a personal focus silently stop applying.
      overridden_by_project: resolved.overrides,
      // Keys the project file sets that only the global file may, and that
      // therefore do nothing. A setting you wrote that silently does not apply
      // is the thing to say out loud.
      ignored_in_project: resolved.ignored,
    };
  },
};

/** A namespace is a config key whose default is an object. */
function isNamespace(key: string): boolean {
  const value = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const setConfig: ToolDef = {
  name: 'set_config',
  title: 'Set config',
  description:
    'Update Eklavya config. Scope "global" writes ~/.eklavya/config.json; scope "project" writes ~/.eklavya/projects/<checkout>/config.json, which is how you set the commit gate — or a difficulty level — for one codebase without putting a file in it. Nothing is ever written into the repository, so these settings are yours and not your teammates\'. ("repo" is accepted as the older name for "project".) Scope "session" writes no file at all: it takes only `quiz`, silences this one session when `quiz.enabled` is false, and un-silences it when true. Use it whenever someone asks to turn the questions off "for now" or "for this session" — writing it to a file instead leaves them off long after the afternoon that needed it. Note that silencing questions never stops memory: `memory.enabled` is a separate switch, and someone asking for quiet has not asked to stop recording their work.',
  inputSchema: {
    scope: z
      .enum(['global', 'project', 'repo', 'session'])
      .optional()
      .describe('Defaults to global. "project" is this checkout, stored outside it under ~/.eklavya/projects/. "session" lasts until this session ends and takes only quiz.'),
    cwd: z.string().optional().describe(CWD_HINT),
    session_id: z.string().optional().describe(SESSION_HINT),
    quiz: z
      .object({
        enabled: z.boolean().optional(),
        enforced: z.boolean().optional(),
      })
      .optional()
      .describe(
        'Whether questions happen (`enabled`, default true) and whether they gate commits (`enforced`, default false). These are the quiz half only — memory keeps recording either way, under `memory.enabled`. Setting enabled:false forces enforced:false, since a gate with no questions can never be passed.',
      ),
    mode: z
      .enum(['ambient', 'enforced', 'off'])
      .optional()
      .describe(
        'Deprecated alias for `quiz`, still honoured so older configs keep working: ambient = {enabled:true,enforced:false}, enforced = {enabled:true,enforced:true}, off = {enabled:false}. Prefer `quiz` — "off" is what made developers think it stopped memory too.',
      ),
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
        'How hard questions on a project may get. "auto" (default) earns the level per project: everyone starts at easy (tiers 1-2), then medium (2-4), then hard (3-5). A literal level pins it and stops progression — "easy" at project scope keeps an onboarding codebase gentle, "hard" globally skips the runway.',
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
    // The namespaced half. Passed as objects rather than as dotted keys because
    // the schema is what the model reads: a `memory` object with named fields
    // tells it what exists, where a free-form `key`/`value` pair would not.
    // Only the fields given are changed -- the rest of the namespace is kept.
    memory: z
      .object({
        enabled: z.boolean().optional(),
        capture: z.enum(['full', 'minimal', 'off']).optional(),
        batch_max_events: z.number().int().min(1).max(500).optional(),
        retention_days: z.number().int().min(1).nullable().optional(),
      })
      .optional()
      .describe(
        'Recording what each session did. Independent of `quiz`: silencing questions means no questions, not no history. Turn capture off with enabled:false, or thin it with capture:"minimal" (prompts and session seams only).',
      ),
    retrieval: z
      .object({
        mode: z.enum(['keyword', 'semantic', 'hybrid']).optional(),
        max_items: z.number().int().min(1).max(50).optional(),
        max_tokens: z.number().int().min(100).max(20000).optional(),
        cross_project: z.boolean().optional(),
      })
      .optional()
      .describe(
        'How memory is searched and how much is handed back at a session seam. "hybrid" (default) is keyword and vectors fused; "keyword" alone cannot match a morphological variant or an unspaced script.',
      ),
    privacy: z
      .object({
        exclude_paths: z.array(z.string()).optional(),
        exclude_tools: z.array(z.string()).optional(),
        redact_patterns: z.array(z.string()).optional(),
      })
      .optional()
      .describe(
        'What is never captured, on top of the built-in secret shapes and credential paths. Additive, not a replacement.',
      ),
    notifications: z
      .object({
        enabled: z.boolean().optional(),
        sinks: z
          .array(
            z.object({
              kind: z.enum(['webhook', 'command', 'file']),
              target: z.string(),
              args: z.array(z.string()).optional(),
              events: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .optional()
      .describe(
        'Where session wrap-ups go. Off by default. A send cannot be recalled, so do not configure one without being asked to.',
      ),
    sync: z
      .object({
        enabled: z.boolean().optional(),
        target: z.string().nullable().optional(),
        device_id: z.string().nullable().optional(),
      })
      .optional()
      .describe(
        'Multi-device sync through a shared directory. Off by default. Memory entries cross; attempts, mastery and gates never do.',
      ),
    providers: z
      .object({
        observer: z
          .object({ kind: z.literal('anthropic'), model: z.string() })
          .nullable()
          .optional(),
        embeddings: z
          .object({ kind: z.literal('anthropic'), model: z.string() })
          .nullable()
          .optional(),
      })
      .optional()
      .describe(
        'Outbound model access, and the only setting that sends captured work off this machine. The model runs through Claude Code on the developer\'s subscription. Requires the developer to say yes; do not set it on their behalf.',
      ),
  },
  handler: (args: Record<string, unknown>, ctx) => {
    // `repo` is the older spelling of `project`, kept working because it is in
    // every skill and doc written before the settings file left the checkout.
    const rawScope = (args.scope as 'global' | 'project' | 'repo' | 'session' | undefined) ?? 'global';
    const scope = rawScope === 'repo' ? 'project' : rawScope;
    const cwd = args.cwd as string | undefined;
    const resolved = loadConfig(cwd);

    // Derived from DEFAULT_CONFIG rather than hand-listed. A hand-listed copy is a
    // second place a new key has to be added, and forgetting it is invisible:
    // the schema accepts the key, the tool reports success, and the setting is
    // silently dropped on the floor. `scope` and `cwd` are not config keys, so
    // they cannot leak into the file.
    // `mode` folded into `quiz` before anything reads the patch. The patch is
    // built from `Object.keys(DEFAULT_CONFIG)` and `mode` is not a key there any
    // more, so without this the schema would go on accepting the word and then
    // drop it on the floor -- the exact silent-no-op failure that building the
    // patch from the defaults was introduced to prevent.
    //
    // An explicit `quiz` wins, matching `coerce()`: the new spelling is never
    // overridden by a legacy one sent in the same call.
    const modeArg = args.mode as string | undefined;
    if (modeArg && args.quiz === undefined) {
      if (modeArg === 'ambient') args.quiz = { enabled: true, enforced: false };
      else if (modeArg === 'enforced') args.quiz = { enabled: true, enforced: true };
      else if (modeArg === 'off') args.quiz = { enabled: false, enforced: false };
    }

    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (args[key] !== undefined) patch[key] = args[key];
    }

    if (Object.keys(patch).length === 0) {
      return { error: 'nothing_to_set', detail: 'Pass at least one setting to change.' };
    }

    // A namespace arrives as a partial object, and the two config files merge
    // with a shallow spread -- so writing it as given would drop every other
    // key the file already had in it. Merge over what is there instead.
    const namespaced = Object.keys(patch).filter((key) => isNamespace(key));

    if (scope === 'session') {
      // Only the quiz switch is session-scoped. The rest are settings, not an
      // interruption someone wants to stop right now, and a per-session
      // `difficulty` that vanished at the end of the day would be a dial that
      // silently un-set itself. `mode` is still accepted here for the same
      // reason `coerce` still reads it.
      const extra = Object.keys(patch).filter((key) => key !== 'quiz');
      const quizPatch = patch.quiz as Record<string, unknown> | undefined;
      const silencing = typeof quizPatch?.enabled === 'boolean' ? !quizPatch.enabled : undefined;
      if (extra.length > 0 || silencing === undefined) {
        return {
          error: 'session_scope_is_quiz_only',
          detail:
            'Scope "session" takes only quiz.enabled: false to silence this session, true to bring it back. Everything else needs global or project scope. Memory is unaffected either way — it has no session-scoped switch, because a session nobody records is a day of work nobody can look up.',
        };
      }

      const session = resolveSessionId(ctx.db, args.session_id as string | undefined, cwd);

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
            'No Claude Code session is registered, so there is nothing to scope this to — the hooks are what stamp the session id, and they have not run. Use scope "global" (and set quiz.enabled back afterwards) or pass session_id explicitly.',
        };
      }

      const off = silencing;
      setSessionOff(ctx.db, session, off);

      return {
        scope,
        session_id: session,
        session_off: off,
        // The file-backed config is untouched, so say what it still is: turning
        // a session back on restores this, not whatever was passed here.
        config: resolved.config,
        // Honest about the one thing a session cannot turn off. The git
        // pre-commit hook reads the project config and never sees a session id,
        // so a silenced session still meets an enforced gate at commit.
        note:
          off && resolved.config.quiz.enforced
            ? 'Questions are silenced for this session, but this project sets quiz.enforced and the commit gate still holds — and it keeps growing, because work logged while you are silent still counts toward it. The quiz has to happen before a commit lands.'
            : undefined,
      };
    }

    // No forbidden-key list on this path. It existed because a project's
    // settings were a file you got by cloning, so a stranger's `.eklavya.json`
    // could aim a notification sink at a shell command and the Stop hook would
    // fire it. What this tool writes lives under ~/.eklavya/projects/ and comes
    // from the developer, so there is nothing to refuse here.
    //
    // The filter still exists for the one path that reads a checkout: see
    // `withoutUntrustedKeys` in config.ts, which guards the legacy
    // `<repo>/.eklavya.json` both while it is read and as it is moved.
    let target: string;
    if (scope === 'project') {
      if (!resolved.projectPath) {
        return {
          error: 'no_repo_root',
          detail:
            'No git repository found from this directory, so there is no project to scope this to. Project settings are keyed by the checkout\'s path and kept under ~/.eklavya/projects/ — nothing is written into the repository itself.',
        };
      }
      // Refused here, before anything is read or written, with its own code:
      // `writeConfigFile` would refuse it too, but as a generic throw that
      // reads like a slug collision, which sends the model after the wrong fix.
      const globalOnly = Object.keys(patch).filter(isGlobalOnlyKey);
      if (globalOnly.length > 0) {
        return {
          error: 'global_only',
          keys: globalOnly,
          detail: `${globalOnly.join(', ')} can only be set in the global config (${resolved.globalPath}), not for one project: the memory queue is shared by every project, so this decides what leaves the machine for all of them. Use scope "global".`,
        };
      }
      target = resolved.projectPath;
      // Which checkout this file is about, exactly as the CLI writes it. Without
      // it `belongsTo` has nothing to compare and trusts the file, so two
      // checkouts whose slugs collide would silently share one config -- and a
      // file the CLI had already stamped for another checkout would be mutated
      // here while this project's own read discarded it, with the tool still
      // reporting success for a setting that never applied.
      patch.project = resolved.repoRoot ? mainRepoRoot(resolved.repoRoot) : undefined;
    } else {
      target = resolved.globalPath;
    }

    if (namespaced.length) {
      const existing = readConfigFile(target);
      for (const key of namespaced) {
        const current = existing[key];
        patch[key] = {
          ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
          ...(patch[key] as Record<string, unknown>),
        };
      }
    }

    try {
      writeConfigFile(target, patch);
    } catch (err) {
      // A file that exists and does not parse is somebody's settings with a
      // typo in them; nothing was written, and the fix is to repair the file,
      // not to pick a different scope.
      if (err instanceof UnreadableFileError) {
        return { error: 'unreadable_config', file: err.file, detail: err.message };
      }
      return { error: 'project_collision', detail: err instanceof Error ? err.message : String(err) };
    }

    return { written_to: target, scope, config: loadConfig(cwd).config };
  },
};
