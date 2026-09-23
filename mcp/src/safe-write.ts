import fs from 'node:fs';
import path from 'node:path';

/**
 * Writing files that belong to the developer, not to Eklavya.
 *
 * `~/.claude/settings.json`, Claude Code's plugin registries, a git
 * `pre-commit` hook, `~/.eklavya/config.json`: each is something a person may
 * have spent an afternoon on. Eklavya once read an unparseable settings file as
 * `{}` and wrote its three keys over the top, deleting the developer's
 * permissions and hooks. Two rules stop that happening again, and every write
 * to such a file routes through here so neither can be forgotten:
 *
 *   1. A file that exists but cannot be understood is never overwritten.
 *      `readJsonStrict` says so explicitly, and callers refuse to write.
 *   2. Before a file that exists is changed, its previous bytes are copied to
 *      `<file>.eklavya-bak`, so any write can be undone by hand with one `mv`.
 */

export const BACKUP_SUFFIX = '.eklavya-bak';

export type JsonRead =
  | { kind: 'missing' }
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'invalid'; error: string };

/**
 * Reads a JSON object, telling "no file" apart from "a file we cannot read".
 *
 * An empty or whitespace-only file counts as missing: there is nothing in it to
 * lose, and editors leave such files behind. JSON that parses but is not a plain
 * object (an array, a string, `null`) is invalid, because merging keys into it
 * would replace what the developer wrote.
 */
export function readJsonStrict(file: string): JsonRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', error: (err as Error).message };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') return { kind: 'missing' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { kind: 'invalid', error: (err as Error).message };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', error: 'expected a JSON object' };
  }
  return { kind: 'ok', value: value as Record<string, unknown> };
}

/** Thrown when a file exists but is not safe to merge into. The message names the file and the fix. */
export class UnreadableFileError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`${file} is not valid JSON (${reason}). Eklavya did not change it. Fix or remove the file, then run this again.`);
    this.name = 'UnreadableFileError';
  }
}

/** `readJsonStrict` for callers about to write: missing is `{}`, invalid throws. */
export function readJsonForUpdate(file: string): Record<string, unknown> {
  const read = readJsonStrict(file);
  if (read.kind === 'invalid') throw new UnreadableFileError(file, read.error);
  return read.kind === 'ok' ? read.value : {};
}

export interface WriteResult {
  /** False when the file already held exactly these bytes and nothing was touched. */
  changed: boolean;
  /** The backup written for this change, if the file existed before. */
  backup: string | null;
}

export interface WriteOptions {
  /** Permission bits for the file (and backup). Default: keep the existing file's. */
  mode?: number;
  /**
   * Files already backed up during this run. When one command writes the same
   * file twice (install registers the plugin, then switches Claude Mem off, both
   * in `settings.json`), the second write must not roll the backup forward onto
   * the first write's result: the backup has to stay the developer's own file.
   * Pass one Set for the whole run; a file in it is written without a new backup.
   */
  run?: Set<string>;
}

/**
 * Replaces `file` with `content`, backing up what was there first.
 *
 * - Unchanged content is a no-op: no write, no backup, so re-running an install
 *   never replaces a useful backup with an identical copy of the current file.
 * - The backup is one rolling file, the state immediately before Eklavya's most
 *   recent change to this file (or, with `run`, before this command's first).
 * - The write goes to a temp file in the same directory and is renamed into
 *   place, so a reader (Claude Code, git) never sees half a file, and a crash
 *   leaves either the old file or the new one.
 * - The file's permission bits are kept: a `pre-commit` hook must stay
 *   executable, a private settings file must stay private.
 * - A symlinked file is written through, never replaced by a regular file:
 *   dotfile managers link `settings.json` into a repo.
 */
export function writeWithBackup(file: string, content: string, opts: WriteOptions = {}): WriteResult {
  const target = resolveLink(file);
  let previous: Buffer | null = null;
  let mode = opts.mode;
  try {
    previous = fs.readFileSync(target);
    if (mode === undefined) mode = fs.statSync(target).mode & 0o7777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (previous !== null && previous.equals(Buffer.from(content, 'utf8'))) {
    return { changed: false, backup: null };
  }

  let backup: string | null = null;
  const key = path.resolve(target);
  if (previous !== null && !opts.run?.has(key)) {
    backup = `${file}${BACKUP_SUFFIX}`;
    atomicWrite(backup, previous, mode);
  }
  opts.run?.add(key);
  atomicWrite(target, content, mode);
  return { changed: true, backup };
}

/** JSON in the house style: two-space indent, trailing newline. */
export function writeJsonWithBackup(file: string, data: unknown, opts: WriteOptions = {}): WriteResult {
  return writeWithBackup(file, `${JSON.stringify(data, null, 2)}\n`, opts);
}

function atomicWrite(file: string, data: string | Buffer, mode: number | undefined): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    // writeFileSync's mode is filtered by the umask; chmod states it exactly.
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Follows a symlink chain to the file it names, even if that file does not exist yet. */
function resolveLink(file: string): string {
  let current = file;
  for (let hops = 0; hops < 32; hops++) {
    let link: string;
    try {
      link = fs.readlinkSync(current);
    } catch {
      return current;
    }
    current = path.resolve(path.dirname(current), link);
  }
  return current;
}
