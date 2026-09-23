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

/** A file claimed for replay: renamed away from the live spool, deleted only once replayed. */
const TAKING = '.taking-';
/** What the previous shape named its claimed file; still replayed, never written. */
const LEGACY_TAKING = '.replay-';

export function spoolPath(): string {
  return path.join(eklavyaHome(), 'spool', 'events.jsonl');
}

/**
 * The live spool plus every claimed-but-unreplayed file. Counting only the live
 * file let a database that refuses every write grow the spool without end: each
 * seam renamed the live file away, failed its first record, and started a fresh
 * one under the cap.
 */
function spooledBytes(file: string): number {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let total = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (name === base || name.startsWith(`${base}${TAKING}`) || name.startsWith(`${base}${LEGACY_TAKING}`)) {
      try {
        total += fs.statSync(path.join(dir, name)).size;
      } catch {
        /* Replayed and removed between the listing and the stat. */
      }
    }
  }
  return total;
}

function droppedPath(): string {
  return path.join(eklavyaHome(), 'spool', 'dropped.json');
}

export function spoolEvent(record: unknown): 'spooled' | 'dropped' {
  const file = spoolPath();
  try {
    // Owner-only, like the database it stands in for: a spooled prompt is
    // evidence, and a world-readable home directory must not make it anyone's.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (spooledBytes(file) > MAX_BYTES) {
      noteDropped();
      return 'dropped';
    }
    // One `appendFileSync` of a single line under the pipe buffer is atomic
    // enough for concurrent hook processes: neither interleaves a partial line.
    // `mode` applies only when this call creates the file, which is the case
    // that matters — the umask would otherwise decide.
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
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
 * Claims the spool for replay and returns what it holds, plus `commit` to call
 * once every record is safely in the database (or back in the spool).
 *
 * The rename is the claim: a hook writing concurrently appends to a fresh file
 * rather than to the one being replayed, so nothing written during the replay
 * is lost. The claimed file is deleted only by `commit`, never on read — the
 * first shape deleted it straight after reading, so a drain that died mid-replay
 * took every record it had not yet written with it. A claimed file left behind
 * by a crash is picked up by the next drain; two drains picking up the same one
 * both replay it, which `event_uid` makes a no-op.
 */
function readable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function takeSpooled(): { records: unknown[]; commit: () => void } {
  const file = spoolPath();
  const dir = path.dirname(file);
  const base = path.basename(file);
  const claimed: string[] = [];
  try {
    const isClaim = (name: string) => name.startsWith(`${base}${TAKING}`) || name.startsWith(`${base}${LEGACY_TAKING}`);
    // Only a claim that can actually be read counts: one that never can (a
    // directory by that name, no read permission) would otherwise block the
    // live file for good while the cap, which counts it, drops every new event.
    const leftover = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((name) => isClaim(name) && readable(path.join(dir, name)));
    // An earlier claim still unreplayed means the database is refusing writes:
    // replay that first and leave the live file alone, rather than stacking up
    // one claimed file per seam that all fail the same way.
    if (leftover.length === 0 && fs.existsSync(file)) {
      const taken = `${file}${TAKING}${process.pid}-${Date.now()}`;
      fs.renameSync(file, taken);
    }
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (isClaim(name)) claimed.push(path.join(dir, name));
    }
  } catch {
    /* Whatever was claimed before the failure is still replayed below. */
  }

  const records: unknown[] = [];
  const read: string[] = [];
  for (const taken of claimed) {
    try {
      for (const line of fs.readFileSync(taken, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          records.push(JSON.parse(line) as unknown);
        } catch {
          /* A torn line is unrecoverable; the rest of the file is not. */
        }
      }
      read.push(taken);
    } catch {
      /* Unreadable now; left in place for the next drain. */
    }
  }

  return {
    records,
    commit: () => {
      for (const taken of read) {
        try {
          fs.rmSync(taken, { force: true });
        } catch {
          /* Replayed again next time, idempotently. */
        }
      }
    },
  };
}
