import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
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
    const command = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya.command;
    expect(command).toMatch(/eklavya-mcp\.sh/);
    expect(command).not.toMatch(/dist\/server\.js/);
  });

  it('.mcp.json does not quote the command — it is a path, not a shell string', () => {
    // Quoting ${CLAUDE_PLUGIN_ROOT} is correct in hooks.json, whose commands run
    // through a shell. An MCP `command` is spawned directly, so an embedded
    // quote becomes part of the filename and the server silently never starts:
    // the plugin loads, skills and agents register, and every tool is missing.
    const command = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya.command;
    expect(command).not.toMatch(/["']/);
  });

  it('the command resolves to a real executable once the placeholder expands', () => {
    const command = readJson(path.join(repoRoot, '.mcp.json')).mcpServers.eklavya.command;
    const resolved = command.replace('${CLAUDE_PLUGIN_ROOT}', repoRoot);
    expect(fs.existsSync(resolved), `${resolved} does not exist`).toBe(true);
    expect(fs.statSync(resolved).mode & 0o111).toBeGreaterThan(0);
  });
});
