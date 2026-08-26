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

describe('what ships to the plugin', () => {
  it('the launcher is tracked and executable — plugin installs get no build step', () => {
    const launcher = path.join(mcpRoot, 'bin', 'eklavya-mcp.sh');
    expect(fs.existsSync(launcher)).toBe(true);
    expect(fs.statSync(launcher).mode & 0o111).toBeGreaterThan(0);
  });

  it('.mcp.json launches through the wrapper, not a path that is gitignored', () => {
    const mcpConfig = readJson(path.join(repoRoot, '.mcp.json'));
    const command = mcpConfig.mcpServers.eklavya.command;
    expect(command).toMatch(/eklavya-mcp\.sh/);
    expect(command).not.toMatch(/dist\/server\.js/);
  });
});
