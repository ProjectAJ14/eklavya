import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `eklavya install` writes three files that belong to Claude Code, not to us:
 * known_marketplaces.json, installed_plugins.json and settings.json. There is no
 * public API for "install this plugin" from outside a session, so we reproduce
 * what `/plugin install` does — which means these tests are the only thing
 * standing between a bad edit and someone's Claude Code configuration.
 *
 * The install is driven through the built CLI rather than by importing it, so
 * what runs here is what a user runs.
 */
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(mcpRoot, 'dist', 'cli.js');

let claudeHome = '';
let eklavyaHome = '';

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

function run(args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      EKLAVYA_HOME: eklavyaHome,
      EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
      EKLAVYA_RUNTIME: path.join(eklavyaHome, 'runtime'),
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// `--skip-runtime` everywhere: the runtime step shells out to npm and would put
// a network fetch in the unit suite. What it does is verified by hand and by
// `verifyRuntime` at install time; what these tests own is the registry writing.
const install = () => run(['install', '--skip-runtime']);

beforeEach(() => {
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-claude-'));
  eklavyaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
});

afterEach(() => {
  for (const dir of [claudeHome, eklavyaHome]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('eklavya install', () => {
  it('registers the plugin the way /plugin install would', () => {
    expect(install().status).toBe(0);

    const marketplaces = readJson(path.join(claudeHome, 'plugins', 'known_marketplaces.json'));
    // The GitHub source is deliberate even though the files came from npm: it is
    // what lets Claude Code's own update path take over afterwards.
    expect(marketplaces.eklavya.source).toEqual({ source: 'github', repo: 'ProjectAJ14/eklavya' });
    expect(marketplaces.eklavya.autoUpdate).toBe(true);

    const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
    expect(installed.version).toBe(2);
    expect(installed.plugins['eklavya@eklavya'][0].scope).toBe('user');

    const settings = readJson(path.join(claudeHome, 'settings.json'));
    expect(settings.enabledPlugins['eklavya@eklavya']).toBe(true);
  });

  it('copies a plugin Claude Code can actually load', () => {
    install();
    const dir = path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya');
    for (const entry of ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/run.mjs', 'hooks/hooks.json']) {
      expect(fs.existsSync(path.join(dir, entry)), `missing ${entry}`).toBe(true);
    }
  });

  it('creates and seeds the database, so `doctor` works before Claude Code is opened', () => {
    install();
    expect(fs.existsSync(path.join(eklavyaHome, 'knowledge.db'))).toBe(true);
    expect(run(['doctor']).status).toBe(0);
  });

  it('is idempotent — running it twice is how you upgrade', () => {
    expect(install().status).toBe(0);
    expect(install().status).toBe(0);

    const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
    // One entry, not two appended.
    expect(installed.plugins['eklavya@eklavya']).toHaveLength(1);
  });

  it('leaves other plugins and unrelated settings alone', () => {
    install();

    const settingsPath = path.join(claudeHome, 'settings.json');
    const settings = readJson(settingsPath);
    settings.enabledPlugins['other@else'] = true;
    settings.model = 'opus';
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    install();

    const after = readJson(settingsPath);
    expect(after.enabledPlugins['other@else']).toBe(true);
    expect(after.model).toBe('opus');
  });
});

describe('eklavya uninstall', () => {
  it('removes every trace of the registration', () => {
    install();
    expect(run(['uninstall']).status).toBe(0);

    expect(readJson(path.join(claudeHome, 'plugins', 'known_marketplaces.json')).eklavya).toBeUndefined();
    expect(
      readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json')).plugins['eklavya@eklavya'],
    ).toBeUndefined();
    expect(
      readJson(path.join(claudeHome, 'settings.json')).enabledPlugins['eklavya@eklavya'],
    ).toBeUndefined();
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya'))).toBe(false);
  });

  it('keeps the learning history unless asked to delete it', () => {
    install();
    const db = path.join(eklavyaHome, 'knowledge.db');
    expect(fs.existsSync(db)).toBe(true);

    run(['uninstall']);
    // Months of spaced repetition. An uninstall that takes this without being
    // asked is not an uninstall, it is data loss.
    expect(fs.existsSync(db)).toBe(true);
  });

  it('deletes the learning history on --purge, and only then', () => {
    install();
    run(['uninstall', '--purge']);
    expect(fs.existsSync(path.join(eklavyaHome, 'knowledge.db'))).toBe(false);
  });

  it('does not disturb a neighbouring plugin', () => {
    install();

    const settingsPath = path.join(claudeHome, 'settings.json');
    const settings = readJson(settingsPath);
    settings.enabledPlugins['other@else'] = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const marketplacesPath = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
    const marketplaces = readJson(marketplacesPath);
    marketplaces['someone-else'] = { source: { source: 'github', repo: 'other/thing' } };
    fs.writeFileSync(marketplacesPath, JSON.stringify(marketplaces));

    run(['uninstall']);

    expect(readJson(settingsPath).enabledPlugins['other@else']).toBe(true);
    expect(readJson(marketplacesPath)['someone-else']).toBeDefined();
  });
});
