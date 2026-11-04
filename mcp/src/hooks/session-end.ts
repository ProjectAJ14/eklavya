/**
 * SessionEnd: price the session that just ended (issue #261).
 *
 * Starts `eklavya fold <session>` in a detached process and exits 0. The fold
 * reads the whole transcript, which a hook must never do, and a hook may not
 * wait for anything. `SessionEnd` is not always delivered (a killed terminal
 * sends nothing), so the next session start also folds any session whose
 * transcript has been quiet for ten minutes.
 */
import { run, config, cwdOf, openExisting, sessionId } from './lib.js';
import { economyOff } from './economy-lib.js';
import { identityOf } from './capture-lib.js';
import { openSession, startFold } from '../ledger-pending.js';
import { runtimeCliPath } from './economy-lib.js';

await run(async (input) => {
  const db = openExisting();
  if (!db) return 0;
  const cwd = cwdOf(input);
  const resolved = config(cwd);
  if (!resolved.config.economy.ledger || economyOff()) return 0;
  const sid = sessionId(input, db);
  if (!sid) return 0;
  const transcript = typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : null;
  openSession(db, { sessionId: sid, project: identityOf(input, cwd, sid).project, transcriptPath: transcript });
  db.close();
  startFold(runtimeCliPath(), [sid, ...(transcript ? ['--transcript', transcript] : [])]);
  return 0;
});
