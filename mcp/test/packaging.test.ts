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
  it('the plugin manifest and the package agree', () => {
    const pluginVersion = readJson(path.join(repoRoot, '.claude-plugin', 'plugin.json')).version;
    const packageVersion = readJson(path.join(mcpRoot, 'package.json')).version;

    // Drift here means a plugin installed from git silently runs a different
    // server version than the one it was released with.
    expect(packageVersion).toBe(pluginVersion);
  });

  it('the launcher reads the version instead of carrying its own copy', () => {
    // There used to be a third place to keep in step -- PINNED_VERSION in a
    // shell launcher -- and keeping it in step was a manual step that a release
    // could forget. run.mjs reads plugin.json at runtime, so the only way to be
    // wrong now is for the two files above to disagree.
    const launcher = fs.readFileSync(path.join(repoRoot, 'hooks', 'run.mjs'), 'utf8');
    expect(launcher).not.toMatch(/\d+\.\d+\.\d+/);
    expect(launcher).toMatch(/plugin\.json/);
  });
});

describe('what ships to npm', () => {
  it('includes the built server and the plugin payload', () => {
    const files = readJson(path.join(mcpRoot, 'package.json')).files;
    expect(files).toContain('dist');
  });

  it('exposes exactly one binary', () => {
    // One package, one command. The server used to be a second bin called
    // `eklavya-mcp`, which forced every standalone MCP config and the npx
    // fallback through `npx --package eklavya eklavya-mcp`. It is `eklavya
    // serve` now, so there is one name to know.
    const bin = readJson(path.join(mcpRoot, 'package.json')).bin;
    expect(Object.keys(bin)).toEqual(['eklavya']);
    expect(bin['eklavya']).toBe('dist/cli.js');
  });

  it('starts the MCP server through `eklavya serve`', () => {
    const cli = path.join(mcpRoot, 'dist', 'cli.js');
    expect(probe([cli, 'serve'], os.tmpdir())).toMatch(/"serverInfo"/);
  });

  it('the npx fallback asks for the command that exists', () => {
    // If this drifts from the bin above, the /plugin-install route silently
    // loses its server: npx would resolve a binary name that is not there.
    const launcher = fs.readFileSync(path.join(repoRoot, 'hooks', 'run.mjs'), 'utf8');
    expect(launcher).toMatch(/'serve'/);
    expect(launcher).not.toMatch(/eklavya-mcp/);
  });

  it('is published under the name `npx eklavya install` needs', () => {
    // `npx <name> install` resolves the package by name, so the documented
    // one-line install only works while the package is called this.
    expect(readJson(path.join(mcpRoot, 'package.json')).name).toBe('eklavya');
  });

  it('requires a Node new enough to have a prebuilt SQLite driver', () => {
    // Below Node 22 better-sqlite3 has no prebuild for the platforms Eklavya
    // supports, so npm falls through to node-gyp and the install needs a C++
    // toolchain -- which is exactly the Windows failure `eklavya install` exists
    // to avoid. Declaring it here is what makes npm refuse early and clearly.
    expect(readJson(path.join(mcpRoot, 'package.json')).engines.node).toBe('>=22');
  });

  it('carries the whole plugin, so installing needs no second download', () => {
    const payload = path.join(mcpRoot, 'dist', 'plugin');
    for (const entry of ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/run.mjs', 'hooks/hooks.json', 'skills', 'agents']) {
      expect(fs.existsSync(path.join(payload, entry)), `missing ${entry}`).toBe(true);
    }
  });

  it('carries the user-level skill, and only through one route', () => {
    expect(fs.existsSync(path.join(mcpRoot, 'dist', 'user-skill', 'eklavya', 'SKILL.md'))).toBe(true);
    // Not under skills/ as well: that whole directory becomes the plugin
    // payload, and a skill shipped through both routes registers twice in the
    // same session.
    expect(fs.existsSync(path.join(mcpRoot, 'dist', 'plugin', 'skills', 'eklavya'))).toBe(false);
  });

  it('does not ship the shell hooks it replaced', () => {
    // They were unreliable on Windows, which is why they are gone. A stale copy
    // shipping alongside the Node ones is how they come back.
    const hooks = fs.readdirSync(path.join(mcpRoot, 'dist', 'plugin', 'hooks'));
    expect(hooks.filter((f) => f.endsWith('.sh'))).toEqual([]);
  });
});

describe('CI can actually run what it publishes', () => {
  it('the release workflow uses a Node that satisfies engines', () => {
    // These drifted once: engines went to >=22 while the workflow stayed on 20,
    // so `eklavya install` correctly refused to run and took 13 tests with it.
    // The failure is easy to misread as a bug in the installer rather than a
    // stale workflow, which is why it is asserted here.
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const ciMajor = Number(workflow.match(/node-version:\s*'(\d+)'/)?.[1]);
    const required = Number(
      readJson(path.join(mcpRoot, 'package.json')).engines.node.match(/(\d+)/)[1],
    );

    expect(Number.isNaN(ciMajor)).toBe(false);
    expect(ciMajor).toBeGreaterThanOrEqual(required);
  });
});

describe('the running server reports its real version', () => {
  it('does not hardcode a version that publishing will leave behind', () => {
    const source = fs.readFileSync(path.join(mcpRoot, 'src', 'server.ts'), 'utf8');
    expect(source).not.toMatch(/version:\s*'\d+\.\d+\.\d+'/);
  });
});

describe('hooks run on every platform', () => {
  it('every hook is exec form: node plus a script path', () => {
    // Shell form on Windows resolves to Git Bash, PowerShell, or WSL's bash
    // depending on what is installed, and a .sh hook fails differently in each
    // (claude-code#18610, #21847, #23556, #73971). `node` is a real executable
    // everywhere, and exec form spawns it without a shell at all.
    const { hooks } = readJson(path.join(repoRoot, 'hooks', 'hooks.json'));
    const all = Object.values(hooks).flat() as Array<{ hooks: Array<Record<string, unknown>> }>;

    expect(all.length).toBeGreaterThan(0);
    for (const matcher of all) {
      for (const hook of matcher.hooks) {
        expect(hook.command).toBe('node');
        expect(Array.isArray(hook.args)).toBe(true);
        expect((hook.args as string[])[0]).toMatch(/run\.mjs$/);
      }
    }
  });

  it('names a hook script that exists', () => {
    const { hooks } = readJson(path.join(repoRoot, 'hooks', 'hooks.json'));
    const all = Object.values(hooks).flat() as Array<{ hooks: Array<{ args: string[] }> }>;

    for (const matcher of all) {
      for (const hook of matcher.hooks) {
        const built = path.join(mcpRoot, 'dist', 'hooks', `${hook.args[1]}.js`);
        expect(fs.existsSync(built), `no build for ${hook.args[1]}`).toBe(true);
      }
    }
  });
});

describe('what ships to the plugin', () => {
  it('both install routes ship the same .mcp.json', () => {
    // The marketplace clones this repository and serves it as the plugin; the
    // npm payload copies the same tree. So there is exactly one shape, and it
    // has to be the one the plugin loader can resolve.
    const repo = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya;
    const shipped = readJson(path.join(mcpRoot, 'dist', 'plugin', '.mcp.json')).mcpServers.eklavya;
    expect(shipped).toEqual(repo);
  });

  it('the MCP command is an absolute placeholder, never a relative path', () => {
    // This is the regression that shipped in 1.8.0. A bare `hooks/run.mjs`
    // resolves against the process cwd, which for a plugin-scoped MCP server is
    // the user's project -- so the server died with "Cannot find module" for
    // everyone who installed from the marketplace.
    const server = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya;
    expect(server.command).toBe('node');
    expect(server.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs');
  });

  it('starts the server from a cwd that is not the plugin', () => {
    // The test this replaces ran from the repo root, where a relative path
    // happens to resolve -- which is precisely why it did not catch the bug.
    // The loader expands the placeholder and spawns with the user's project as
    // cwd, so that is what gets simulated here.
    const server = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya;
    const args = server.args.map((a: string) =>
      a.replace('${CLAUDE_PLUGIN_ROOT}', repoRoot),
    );

    expect(probe(args, os.tmpdir(), repoRoot)).toMatch(/"serverInfo"/);
  });
});

/**
 * Runs the launcher the way a client would and speaks one `initialize` to it.
 * Closing stdin ends the server, so this returns its whole reply.
 */
function probe(args: string[], cwd: string, pluginRoot?: string): string {
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

  return execFileSync(process.execPath, args, {
    cwd,
    input: `${initialize}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}),
      // Never let a packaging test touch the real learner's database.
      EKLAVYA_DB: path.join(os.tmpdir(), 'eklavya-packaging-probe.db'),
    },
  });
}
