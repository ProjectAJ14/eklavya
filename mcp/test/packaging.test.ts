import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(mcpRoot);

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('version pinning', () => {
  it('the plugin, the package and the launcher all agree', () => {
    const pluginVersion = readJson(path.join(repoRoot, '.claude-plugin', 'plugin.json')).version;
    const packageVersion = readJson(path.join(mcpRoot, 'package.json')).version;
    const launcher = fs.readFileSync(path.join(mcpRoot, 'bin', 'eklavya-mcp.sh'), 'utf8');
    const pinned = launcher.match(/PINNED_VERSION="([^"]+)"/)?.[1];

    // Drift here means a plugin installed from git silently runs a different
    // server version than the one it was released with.
    expect(packageVersion).toBe(pluginVersion);
    expect(pinned).toBe(pluginVersion);
  });
});

describe('what ships to npm', () => {
  it('includes the launcher and the built server', () => {
    const files = readJson(path.join(mcpRoot, 'package.json')).files;
    expect(files).toContain('dist');
    expect(files).toContain('bin');
  });

  it('exposes both binaries', () => {
    const bin = readJson(path.join(mcpRoot, 'package.json')).bin;
    expect(bin['eklavya-mcp']).toBe('dist/server.js');
    expect(bin['eklavya']).toBe('dist/cli.js');
  });
});

describe('the running server reports its real version', () => {
  it('does not hardcode a version that publishing will leave behind', () => {
    const source = fs.readFileSync(path.join(mcpRoot, 'src', 'server.ts'), 'utf8');
    expect(source).not.toMatch(/version:\s*'\d+\.\d+\.\d+'/);
  });
});

describe('what ships to the plugin', () => {
  it('the launcher is tracked and executable — plugin installs get no build step', () => {
    const launcher = path.join(mcpRoot, 'bin', 'eklavya-mcp.sh');
    expect(fs.existsSync(launcher)).toBe(true);
    expect(fs.statSync(launcher).mode & 0o111).toBeGreaterThan(0);
  });

  it('.mcp.json launches through the wrapper, not a path that is gitignored', () => {
    const script = launchScript();
    expect(script).toMatch(/eklavya-mcp\.sh/);
    expect(script).not.toMatch(/dist\/server\.js/);
  });

  it('.mcp.json does not depend on the host expanding a placeholder', () => {
    // `${CLAUDE_PLUGIN_ROOT}` is defined when the plugin loader reads this file
    // and undefined when the same file is read as project-level MCP config —
    // which is how this repo, and any host without plugin support, runs it.
    // An MCP `command` is spawned directly, with no shell, so an unexpanded
    // placeholder becomes part of the filename and the server never starts.
    // Resolution therefore belongs at runtime, in the shell we spawn.
    const server = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya;
    expect(server.command).toBe('sh');
    expect(launchScript()).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
  });

  it('starts the server whether or not the placeholder was expanded', () => {
    // Plugin scope: the loader expanded the root and the cwd is the user's repo.
    expect(probe(pluginRootFromLoader, os.tmpdir())).toMatch(/"serverInfo"/);
    // Project scope: nothing expanded it, so the literal arrives in the env and
    // the cwd is the only thing pointing at the launcher.
    expect(probe(literalPlaceholder, repoRoot)).toMatch(/"serverInfo"/);
  });
});

const launchScript = (): string =>
  readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya.args[1];

const pluginRootFromLoader = repoRoot;
const literalPlaceholder = '${CLAUDE_PLUGIN_ROOT}';

/**
 * Runs the launch script the way a client would and speaks one `initialize` to
 * it. Closing stdin ends the server, so this returns its whole reply.
 */
function probe(pluginRoot: string, cwd: string): string {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'packaging-test', version: '0' },
    },
  });

  return execFileSync('sh', ['-c', launchScript()], {
    cwd,
    input: `${initialize}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      EKLAVYA_PLUGIN_ROOT: pluginRoot,
      // Never let a packaging test touch the real learner's database.
      EKLAVYA_DB: path.join(os.tmpdir(), 'eklavya-packaging-probe.db'),
    },
  });
}
