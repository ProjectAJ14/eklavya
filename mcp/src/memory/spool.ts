import fs from 'node:fs';
import path from 'node:path';
import { eklavyaHome } from '../paths.js';
import { nowIso } from '../time.js';

/**
 * The bounded local spool (PRD CAP-03).
 *
 * The database is normally available — the hooks open it directly — but "the
 * disk is full", "another writer holds the lock past the busy timeout" and "the
 * file is mid-upgrade" all happen, and a session must keep working through
 * them. Events that cannot be committed are appended here as JSON lines and
 * replayed on the next healthy open.
 *
 * Bounded, and honest about the bound: past `MAX_BYTES` new events are dropped
 * and counted rather than allowed to fill the disk that is already full. A
 * dropped event is reported by `eklavya doctor`, never silently promised.
 */

const MAX_BYTES = 4 * 1024 * 1024;

export function spoolPath(): string {
  return path.join(eklavyaHome(), 'spool', 'events.jsonl');
}

function droppedPath(): string {
  return path.join(eklavyaHome(), 'spool', 'dropped.json');
}

export function spoolEvent(record: unknown): 'spooled' | 'dropped' {
  const file = spoolPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size > MAX_BYTES) {
      noteDropped();
      return 'dropped';
    }
    // One `appendFileSync` of a single line under the pipe buffer is atomic
    // enough for concurrent hook processes: neither interleaves a partial line.
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return 'spooled';
  } catch {
    return 'dropped';
  }
}

function noteDropped(): void {
  try {
    const file = droppedPath();
    const prev = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { count?: number })
      : {};
    fs.writeFileSync(file, JSON.stringify({ count: (prev.count ?? 0) + 1, last: nowIso() }), 'utf8');
  } catch {
    // The spool is already the degraded path; a failure to count a drop is not
    // worth taking a session down for.
  }
}

export function droppedCount(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(droppedPath(), 'utf8')) as { count?: number };
    return parsed.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Reads and clears the spool. The rename-then-read order matters: a hook
 * writing concurrently appends to a fresh file rather than to the one being
 * replayed, so nothing is read twice and nothing written during the replay is
 * lost. Idempotent appends downstream make a crash mid-replay harmless.
 */
export function takeSpooled(): unknown[] {
  const file = spoolPath();
  try {
    if (!fs.existsSync(file)) return [];
    const taken = `${file}.replay-${process.pid}`;
    fs.renameSync(file, taken);
    const lines = fs.readFileSync(taken, 'utf8').split('\n').filter(Boolean);
    fs.rmSync(taken, { force: true });
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
