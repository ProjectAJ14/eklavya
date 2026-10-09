/**
 * What counts as a prompt the developer typed, shared by the hook that decides
 * whether to nudge and the feedback review that decides what is worth reading.
 * No imports: a hook loads this on every prompt.
 */

/**
 * Shorter than this and a prompt is a reply -- "yes", "commit it", "go on" --
 * not a task to decide how to build. Not a classifier: a long question still
 * gets the delegation line, and the line says to answer questions yourself.
 * `/wt implement the 0.2 handoff` is 31 characters, and a real task.
 */
export const TASK_PROMPT_CHARS = 25;

/**
 * What the host sends through UserPromptSubmit on its own: a background agent's
 * hand-back and its completion notice. Neither is the developer asking for work,
 * and a session with four builders and three explainers received seven of them.
 */
export const HOST_PROMPT = /^<(agent-message|task-notification)\b/;

/** The user-invocable skills under `skills/`, bare or plugin-qualified. */
export const SLASH = /^\/(?:eklavya:)?(gate|learn|level|memory|mode|pack|progress|quiz|setup|skip)(?![\w-])/;

/**
 * The observer's own `claude -p` sessions, recognised by their first prompt, as
 * SQL. Not the developer's work: telemetry leaves them out of its counts and
 * feedback never reviews them.
 */
export const HELPERS = `(SELECT session_id FROM evidence_events WHERE kind = 'prompt' AND body LIKE '<evidence project=%')`;
export const NOT_HELPER = `(session_id IS NULL OR session_id NOT IN ${HELPERS})`;
