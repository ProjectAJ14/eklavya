import { z } from 'zod';
import path from 'node:path';
import { expand, findSymbol, languageOf, outline } from '../memory/code.js';
import { memoryScope } from './memory_read_tools.js';
import { CWD_HINT, type ToolDef } from './types.js';

/**
 * Structured code exploration (PRD RET-04).
 *
 * The two-stage shape memory uses applies here too, for the same reason: an
 * outline is the cheap thing that says *which file to open*, and opening the
 * file is what the outline lets you avoid doing forty times.
 *
 * The descriptions state the ceiling. This is a declaration scanner, not a
 * parser: it will not resolve a symbol through a re-export, and a language it
 * has no pattern for reports nothing rather than something wrong. A model told
 * otherwise would trust an empty result as proof a symbol does not exist.
 */

const CEILING =
  'Line-oriented declaration scanning, not a parser: no cross-file resolution, and an unsupported language returns no symbols rather than wrong ones. An empty result does not prove a symbol is absent.';

function resolveIn(project: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(project, file);
}

export const codeOutline: ToolDef = {
  name: 'code_outline',
  title: 'Outline a source file',
  description: `The declarations in one file, with line numbers — classes, functions, types, tables — so you can choose what to read instead of reading all of it. Pass 'line' to get the surrounding lines of one declaration instead of the whole outline. ${CEILING}`,
  inputSchema: {
    file: z.string().describe('Path to the file, absolute or relative to the repository root.'),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Expand this line instead of outlining: returns the declaration and the lines around it.'),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { file: string; line?: number; cwd?: string }) => {
    const { project } = memoryScope(args.cwd);
    const file = resolveIn(project, args.file);

    if (args.line) {
      const text = expand(file, args.line);
      return text === null
        ? { error: 'unreadable', file: args.file }
        : { file: args.file, line: args.line, text };
    }

    const parsed = outline(file);
    if (!parsed) {
      return {
        error: languageOf(file) ? 'unreadable' : 'unsupported_language',
        file: args.file,
        detail: CEILING,
      };
    }
    return { ...parsed, file: args.file };
  },
};

export const codeFindSymbol: ToolDef = {
  name: 'code_find_symbol',
  title: 'Find where a symbol is declared',
  description: `Where a name is DECLARED across this repository, with the file, the line and the declaration itself. Declarations only, not every mention — a list of call sites answers a different question. Scoped to this project. ${CEILING}`,
  inputSchema: {
    name: z.string().describe('The symbol name, or part of it. Case-insensitive substring match.'),
    limit: z.number().int().positive().max(50).optional().describe('Maximum hits. Default 20.'),
    cwd: z.string().optional().describe(CWD_HINT),
  },
  handler: (args: { name: string; limit?: number; cwd?: string }) => {
    const { project } = memoryScope(args.cwd);
    if (project === '*') return { error: 'no_repository', detail: 'Code search needs a checkout to search.' };
    const hits = findSymbol(project, args.name, args.limit ?? 20);
    return { name: args.name, hits, count: hits.length, project };
  },
};
