import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { TOOLS } from '../src/tools/index.js';
import { tempDbPath, cleanup } from './helpers.js';

const serverEntry = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'dist',
  'server.js',
);

/** Minimal newline-delimited JSON-RPC client, so the test exercises the real transport. */
class StdioClient {
  private buffer = '';
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(payload + '\n');
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

let dbFile = '';
let proc: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  proc?.kill('SIGTERM');
  proc = undefined;
  if (dbFile) cleanup(dbFile);
  dbFile = '';
});

describe('eklavya-mcp over stdio', () => {
  it('is built before integration tests run', () => {
    expect(fs.existsSync(serverEntry), `missing ${serverEntry} — run npm run build`).toBe(true);
  });

  it('completes the handshake and lists every declared tool', async () => {
    dbFile = tempDbPath('server');
    proc = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, EKLAVYA_DB: dbFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const client = new StdioClient(proc);

    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'eklavya-test', version: '0' },
    });
    expect(init.result.serverInfo.name).toBe('eklavya');
    client.notify('notifications/initialized');

    const listed = await client.request('tools/list');
    const names = (listed.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(TOOLS.map((t) => t.name).sort());

    // Every tool must advertise an input schema, or the model cannot call it.
    for (const tool of listed.result.tools as { name: string; inputSchema: unknown }[]) {
      expect(tool.inputSchema, `${tool.name} has no inputSchema`).toBeTruthy();
    }
  });

  it('creates and migrates the database it was pointed at', async () => {
    dbFile = tempDbPath('server-db');
    proc = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, EKLAVYA_DB: dbFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const client = new StdioClient(proc);
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'eklavya-test', version: '0' },
    });

    expect(fs.existsSync(dbFile)).toBe(true);
    const db = new Database(dbFile, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name);
    for (const t of ['meta', 'concepts', 'edges', 'mastery', 'attempts', 'session_concepts', 'gates']) {
      expect(tables).toContain(t);
    }
    const n = (db.prepare('SELECT count(*) n FROM concepts').get() as { n: number }).n;
    expect(n).toBeGreaterThan(50);
    db.close();
  });
});

describe('the full teaching loop over the real transport', () => {
  it('logs work, quizzes it, grades it, and stops asking once it is known', async () => {
    dbFile = tempDbPath('loop');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ min_minutes_between_quizzes: 0, max_questions_per_task: 4 }),
    );

    try {
      proc = spawn(process.execPath, [serverEntry], {
        env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, EKLAVYA_SESSION_ID: 'e2e' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;

      const client = new StdioClient(proc);
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'eklavya-test', version: '0' },
      });
      client.notify('notifications/initialized');

      const callTool = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await client.request('tools/call', { name, arguments: args });
        expect(res.error, `${name} returned a protocol error`).toBeUndefined();
        return JSON.parse(res.result.content[0].text);
      };

      // 1. The agent logs what the task actually touched.
      const logged = await callTool('log_session_concepts', {
        concepts: [
          { slug: 'httponly-cookies', context: 'set httpOnly on the refresh cookie in auth.ts' },
          { slug: 'jwt-structure', context: 'signed the access token in token.ts' },
        ],
      });
      expect(logged.logged).toEqual(['httponly-cookies', 'jwt-structure']);
      expect(logged.session_id).toBe('e2e');

      // 2. The quiz plan comes back grounded in that code.
      const plan = await callTool('get_session_quiz_plan');
      expect(plan.questions_needed).toBe(2);
      expect(plan.concepts.find((c: any) => c.slug === 'httponly-cookies').context).toMatch(/auth\.ts/);

      // 3. Answering well twice moves the concept to known.
      for (const round of [1, 2]) {
        const res = await callTool('record_attempt', {
          slug: 'jwt-structure',
          question: `round ${round}: what are the three segments and which are readable?`,
          answer: 'header, payload, signature - the first two are base64url, readable by anyone',
          grade: 5,
          difficulty: 2,
          feedback: 'right, encoding is not encryption',
        });
        expect(res.reps).toBe(round);
        expect(Date.parse(res.next_review)).toBeGreaterThan(Date.now());
      }

      // 4. The profile reflects it.
      const profile = await callTool('get_learner_profile', { domain: 'web-auth' });
      expect(profile.domains[0].known).toBe(1);

      // 5. And the next quiz does not ask about it again.
      const plan2 = await callTool('get_session_quiz_plan');
      expect(plan2.concepts.map((c: any) => c.slug)).not.toContain('jwt-structure');
      expect(plan2.concepts.map((c: any) => c.slug)).toContain('httponly-cookies');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
