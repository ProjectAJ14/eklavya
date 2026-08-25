import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
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
