/**
 * `importFrom` on its own thread, so the terminal can show it is working.
 *
 * The importer is synchronous -- better-sqlite3 is -- and a two-month Claude Mem
 * history takes long enough that a frozen cursor reads as a hang. On the main
 * thread no spinner can animate through it; here the main thread is free to.
 * The worker opens its own connection: a better-sqlite3 handle cannot cross.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db.js';
import { guessProjectMap } from '../claude-mem.js';
import { ImportError, importFrom, verifyImport, type ImportOptions, type ImportReport, type VerifyReport } from './import.js';

interface Job {
  dbFile: string;
  source: string;
  opts: ImportOptions;
  /** Set to place projects off Claude Code's transcripts; entries in `opts.projectMap` win. */
  guessFrom?: string;
}

/** What install needs back: the run, the row-by-row check, and names the transcripts could not settle. */
export interface OffThreadResult {
  report: ImportReport;
  verified: VerifyReport;
  unsure: Record<string, string[]>;
}

type Reply = { result: OffThreadResult } | { error: string; importError: boolean };

if (!isMainThread && parentPort) {
  const job = workerData as Job;
  let reply: Reply;
  try {
    const db = openDb(job.dbFile);
    try {
      const unsure: Record<string, string[]> = {};
      const guessed = job.guessFrom ? guessProjectMap(job.source, job.guessFrom, unsure) : {};
      const opts = { ...job.opts, projectMap: { ...guessed, ...job.opts.projectMap } };
      const report = importFrom(db, job.source, opts);
      reply = { result: { report, verified: verifyImport(db, job.source), unsure } };
    } finally {
      db.close();
    }
  } catch (err) {
    reply = { error: (err as Error).message, importError: err instanceof ImportError };
  }
  parentPort.postMessage(reply);
}

/** Runs one import on a worker thread. Rejects with the same errors `importFrom` throws. */
export function importOffThread(job: Job): Promise<OffThreadResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.once('message', (reply: Reply) => {
      if ('result' in reply) resolve(reply.result);
      else reject(reply.importError ? new ImportError(reply.error) : new Error(reply.error));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`import worker exited with code ${code}`));
    });
  });
}
