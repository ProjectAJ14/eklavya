#!/usr/bin/env node
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb } from './db.js';
import { dbPath } from './paths.js';
import { registerTools } from './tools/index.js';

// Read the version rather than hardcoding it: a literal here silently reports a
// stale version forever, since nothing about publishing touches this file.
// `../package.json` resolves the same from src/ under tsx and from dist/ built.
function serverVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// stdout is the MCP transport. Anything diagnostic goes to stderr or it corrupts
// the protocol stream.
function log(message: string): void {
  process.stderr.write(`[eklavya-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  const db = openDb();
  log(`db ready at ${dbPath()}`);

  const server = new McpServer(
    { name: 'eklavya', version: serverVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        'Eklavya tracks what this developer has actually learned. Log the concepts your work touches, ' +
        'and quiz from the learner profile rather than from scratch — never ask about a concept already mastered.',
    },
  );

  registerTools(server, db);

  const shutdown = () => {
    try {
      db.close();
    } catch {
      // closing a already-closed handle on shutdown is not worth reporting
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  log('server connected over stdio');
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
