import { z } from 'zod';
import { policyFrom } from '../memory/capture.js';
import { redact } from '../memory/privacy.js';
import { deleteEntry, entryById, entryEvents, entryTags, insertEntry, supersedeEntry } from '../memory/store.js';
import { resolveSessionId } from '../session.js';
import { memoryScope, parseList } from './memory_read_tools.js';
import { CWD_HINT, type ToolDef } from './types.js';

/**
 * The write half of the memory tools.
 *
 * Everything here runs through the same privacy filter the capture path uses. A
 * note the model was asked to write down is as capable of carrying a secret as
 * a captured tool call, and a filter that only guards the automatic path is a
 * filter with a door next to it.
 */

const SCOPE_RULE = 'Written to this project; memory is project-scoped and cross-project recall is explicit.';

export const memoryWrite: ToolDef = {
  name: 'memory_write',
  title: 'Write a memory note',
  description:
    `Record something worth remembering that no tool call would have captured — a decision, a constraint, a dead end. Secrets are redacted before it is stored. ${SCOPE_RULE}`,
  inputSchema: {
    title: z.string().min(1).describe('One line, specific enough to recognise later in a list of titles.'),
    body: z.string().optional().describe('The detail: what was decided or found, and why.'),
    tags: z.array(z.string()).optional().describe('Lowercased on the way in, e.g. ["auth", "deploy"].'),
    files: z.array(z.string()).optional().describe('Paths this note is about, so memory_file_history finds it.'),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { title: string; body?: string; tags?: string[]; files?: string[]; cwd?: string }, { db }) => {
    const { config, project } = memoryScope(args.cwd);
    const policy = policyFrom(config);
    const title = redact(args.title, policy);
    const body = redact(args.body ?? '', policy);

    const id = insertEntry(db, {
      project,
      sessionId: resolveSessionId(db, undefined, args.cwd),
      kind: 'note',
      type: 'note',
      title: title.text,
      narrative: body.text,
      files: args.files,
      tags: args.tags,
      generator: 'manual',
    });

    const kinds = [...new Set([...title.kinds, ...body.kinds])];
    return { id, project, redacted: kinds.length > 0, redacted_kinds: kinds };
  },
};

export const memoryCorrect: ToolDef = {
  name: 'memory_correct',
  title: 'Correct a memory entry',
  description:
    `Replace a wrong or outdated entry. The original is never edited: the stale claim keeps its evidence links and its place in the audit trail, and only the replacement is returned by retrieval. ${SCOPE_RULE}`,
  inputSchema: {
    id: z.number().int().describe('The entry to supersede, from memory_search or memory_timeline.'),
    title: z.string().optional().describe('The corrected title. Omit to keep the original.'),
    body: z.string().optional().describe('The corrected narrative. Omit to keep the original.'),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { id: number; title?: string; body?: string; cwd?: string }, { db }) => {
    if (args.title === undefined && args.body === undefined) {
      return { error: 'nothing_to_correct', detail: 'Pass a corrected title, a corrected body, or both.' };
    }

    const stale = entryById(db, args.id);
    if (!stale) return { error: 'not_found', detail: `No memory entry with id ${args.id}.` };
    if (stale.superseded_by) {
      return {
        error: 'already_superseded',
        detail: `Entry ${args.id} was already replaced by ${stale.superseded_by}. Correct that one instead.`,
      };
    }

    const policy = policyFrom(memoryScope(args.cwd).config);
    const title = args.title === undefined ? stale.title : redact(args.title, policy).text;
    const narrative = args.body === undefined ? stale.narrative : redact(args.body, policy).text;

    // No `batchId`: `insertEntry` salts the uid with it, so reusing the stale
    // row's batch plus an unchanged title and time would hash to the row being
    // corrected and supersede it with itself.
    const replacementId = insertEntry(db, {
      project: stale.project,
      sessionId: stale.session_id,
      kind: stale.kind as 'observation' | 'session_summary' | 'note',
      type: stale.type,
      title,
      narrative,
      facts: parseList(stale.facts),
      files: parseList(stale.files),
      tags: entryTags(db, stale.id),
      generator: 'manual',
      occurredAt: stale.occurred_at,
      // The replacement is grounded in the same evidence; the original keeps
      // its links too, so the trail reads from either end.
      eventIds: entryEvents(db, stale.id).map((e) => e.id),
    });

    supersedeEntry(db, stale.id, replacementId);
    return { id: replacementId, superseded: stale.id, project: stale.project };
  },
};

export const memoryDelete: ToolDef = {
  name: 'memory_delete',
  title: 'Delete a memory entry',
  description:
    `Remove an entry from retrieval. Soft by default — the row stays in the timeline as a deletion, its search index and vector do not. "hard" erases it outright and cannot be undone. ${SCOPE_RULE}`,
  inputSchema: {
    id: z.number().int().describe('The entry to delete.'),
    hard: z.boolean().optional().describe('Defaults to false. True erases the row instead of marking it deleted.'),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { id: number; hard?: boolean; cwd?: string }, { db }) => {
    const entry = entryById(db, args.id);
    if (!entry) return { error: 'not_found', detail: `No memory entry with id ${args.id}.` };
    const hard = args.hard ?? false;
    deleteEntry(db, args.id, hard);
    return { id: args.id, hard, deleted: true, project: entry.project };
  },
};
