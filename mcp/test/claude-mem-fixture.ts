import Database from 'better-sqlite3';
import { SUPPORTED_SCHEMA_VERSION } from '../src/memory/import.js';

/**
 * Every row below is invented. The real Claude Mem database on a developer's
 * machine is their private history; a test fixture that borrowed from it would
 * put that history in git, so the schema is copied and the content is not.
 */

export const PROJECT = 'demo-repo';
export const SESSION = 'mem-session-1';
export const OCT = Date.UTC(2025, 9, 4, 11, 30, 0); // the original timestamps under test

/** The schema this importer was read against, trimmed to what it imports. */
export function buildSource(sourcePath: string, schemaVersion: number = SUPPORTED_SCHEMA_VERSION): void {
  const src = new Database(sourcePath);
  src.pragma('journal_mode = WAL');
  src.exec(`
    CREATE TABLE schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL, platform_source TEXT NOT NULL DEFAULT 'claude', user_prompt TEXT,
      started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL, completed_at TEXT, completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active', worker_port INTEGER, prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT, observed_model TEXT, observed_billing TEXT);
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
      text TEXT, type TEXT NOT NULL, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT,
      files_read TEXT, files_modified TEXT, prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, content_hash TEXT, generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0, merged_into_project TEXT, agent_type TEXT, agent_id TEXT,
      metadata TEXT, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT,
      sync_rev TEXT NOT NULL DEFAULT '1');
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
      request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, files_read TEXT,
      files_edited TEXT, notes TEXT, prompt_number INTEGER, discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, merged_into_project TEXT,
      synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1');
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER, content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL, prompt_text TEXT NOT NULL, created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL, synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT,
      sync_rev TEXT NOT NULL DEFAULT '1');
    CREATE TABLE tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, content_session_id TEXT NOT NULL,
      memory_session_id TEXT, session_db_id INTEGER, project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude', tool_name TEXT NOT NULL, tool_input TEXT,
      tool_response TEXT, cwd TEXT, prompt_number INTEGER, agent_type TEXT, agent_id TEXT,
      observation_id INTEGER, or_generation_id TEXT, or_session_id TEXT, content_hash TEXT,
      created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL, UNIQUE(content_session_id, tool_use_id));
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_db_id INTEGER NOT NULL, content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL, tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT,
      last_user_message TEXT, last_assistant_message TEXT, prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', created_at_epoch INTEGER NOT NULL, agent_type TEXT,
      agent_id TEXT, tool_use_id TEXT);
    CREATE TABLE sync_state (k TEXT PRIMARY KEY, v TEXT);
  `);

  src.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
    schemaVersion,
    new Date(OCT).toISOString(),
  );
  src
    .prepare(
      `INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (1, 'content-1', ?, ?, ?, ?, 'completed')`,
    )
    .run(SESSION, PROJECT, new Date(OCT).toISOString(), OCT);

  src
    .prepare(
      `INSERT INTO observations
         (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
          files_read, files_modified, prompt_number, created_at, created_at_epoch, generated_by_model, agent_type,
          metadata, origin_device_id, origin_local_id, discovery_tokens)
       VALUES (?, ?, ?, 'bugfix', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'sonnet-test', 'general',
               '{"secret":"do-not-import"}', 'device-abc', 'local-9', 4242)`,
    )
    .run(
      SESSION,
      PROJECT,
      'fallback text',
      'Fixed the refresh token rotation bug',
      'auth kept logging people out',
      JSON.stringify(['tokens rotate on every refresh', 'the old token is revoked']),
      'The refresh handler reused the previous token, so a replayed request logged the user out.',
      JSON.stringify(['refresh-token-rotation', 'JWT expiry']),
      JSON.stringify(['src/auth/session.ts']),
      JSON.stringify(['src/auth/refresh.ts']),
      new Date(OCT).toISOString(),
      OCT,
    );

  src
    .prepare(
      `INSERT INTO observations
         (memory_session_id, project, type, title, narrative, prompt_number, created_at, created_at_epoch, merged_into_project)
       VALUES (?, 'old-name', 'refactor', 'Split the migration runner', 'One guarded runner instead of three.', 2, ?, ?, ?)`,
    )
    .run(SESSION, new Date(OCT + 3_600_000).toISOString(), OCT + 3_600_000, PROJECT);

  src
    .prepare(
      `INSERT INTO session_summaries
         (memory_session_id, project, request, investigated, learned, completed, next_steps, notes,
          files_read, files_edited, created_at, created_at_epoch)
       VALUES (?, ?, 'Make login stop dropping sessions', 'the refresh path', 'rotation must revoke',
               'shipped the fix', 'add a regression test', 'noisy logs', ?, ?, ?, ?)`,
    )
    .run(
      SESSION,
      PROJECT,
      JSON.stringify(['src/auth/session.ts']),
      JSON.stringify(['src/auth/refresh.ts']),
      new Date(OCT + 7_200_000).toISOString(),
      OCT + 7_200_000,
    );

  src
    .prepare(
      `INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES (1, 'content-1', 1, 'why do I keep getting logged out?', ?, ?)`,
    )
    .run(new Date(OCT).toISOString(), OCT);

  src
    .prepare(
      `INSERT INTO tool_uses (tool_use_id, content_session_id, memory_session_id, project, tool_name,
                              tool_input, tool_response, cwd, prompt_number, observation_id,
                              created_at, created_at_epoch, or_generation_id)
       VALUES ('tu-1', 'content-1', ?, ?, 'Edit', '{"file":"src/auth/refresh.ts"}', 'ok', '/work/demo-repo', 1, 1, ?, ?, 'gen-1')`,
    )
    .run(SESSION, PROJECT, new Date(OCT).toISOString(), OCT);

  // A tool use belonging to no observation at all — the source has plenty, and
  // they must still import, just without a link.
  src
    .prepare(
      `INSERT INTO tool_uses (tool_use_id, content_session_id, memory_session_id, project, tool_name,
                              tool_input, tool_response, cwd, created_at, created_at_epoch)
       VALUES ('tu-orphan', 'content-1', ?, ?, 'Read', '{"file":"README.md"}', 'ok', '/work/demo-repo', ?, ?)`,
    )
    .run(SESSION, PROJECT, new Date(OCT + 120_000).toISOString(), OCT + 120_000);

  // Runtime state that must never be copied into Eklavya (PRD MIG-01).
  src
    .prepare(
      `INSERT INTO pending_messages (session_db_id, content_session_id, message_type, created_at_epoch)
       VALUES (1, 'content-1', 'observation', ?)`,
    )
    .run(OCT);
  src.prepare('INSERT INTO sync_state (k, v) VALUES (?, ?)').run('device_id', 'device-abc');

  // Left open until now so the WAL still holds uncheckpointed rows: a bare file
  // copy of the main database would miss them, which is the point of VACUUM INTO.
  src.close();
}
