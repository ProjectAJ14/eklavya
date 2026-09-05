// Copies non-TypeScript runtime assets (SQL migrations, seed graphs) into dist/
// so the built server resolves them the same way it does when run from src via tsx.
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const dir of ['migrations', 'seed']) {
  const from = path.join(root, 'src', dir);
  const to = path.join(root, 'dist', dir);
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
}

// The tutor pedagogy has to travel with the npm package: `eklavya export-rules`
// derives the Cursor rules file from it, and a standalone install has no
// skills/ directory. Copied at build time so SKILL.md stays the single source.
const skill = path.join(path.dirname(root), 'skills', 'tutor', 'SKILL.md');
const assets = path.join(root, 'dist', 'assets');
await mkdir(assets, { recursive: true });
try {
  await cp(skill, path.join(assets, 'tutor-skill.md'));
} catch (err) {
  console.warn(`warning: could not bundle the tutor skill (${err.code ?? err.message})`);
}

// The dashboard page and the design tokens ship with the package: `eklavya
// dashboard` must work from a plain npm install, with no repo checked out.
await cp(path.join(root, 'src', 'assets'), assets, { recursive: true });
const tokens = path.join(path.dirname(root), 'site', 'tokens.css');
try {
  await cp(tokens, path.join(assets, 'tokens.css'));
} catch (err) {
  console.warn(`warning: could not bundle the design tokens (${err.code ?? err.message})`);
}

// The plugin payload travels inside the npm package, which is what makes
// `npx eklavya install` a single command: the installer copies dist/plugin/
// straight into Claude Code's marketplace directory, with no git clone and no
// second network round trip. It is also why the two install routes cannot
// drift — this is the same tree the GitHub marketplace serves.
//
// dist/ only. Nothing here is built; it is copied verbatim so the repo stays
// the single source for hooks, skills and manifests.
const repo = path.dirname(root);
const payload = path.join(root, 'dist', 'plugin');
// Cleared, not merged: `cp` leaves a deleted hook or skill behind forever, and
// a stale file that ships is worse than a slow rebuild.
await rm(payload, { recursive: true, force: true });
await mkdir(payload, { recursive: true });

// `scripts/install-git-hook.sh` by name rather than the whole scripts/ folder:
// bump-version.sh is release tooling and has no business on a user's machine.
for (const entry of [
  '.claude-plugin',
  '.mcp.json',
  'hooks',
  'skills',
  'agents',
  'cli',
  'scripts/install-git-hook.sh',
]) {
  try {
    await cp(path.join(repo, entry), path.join(payload, entry), { recursive: true });
  } catch (err) {
    console.warn(`warning: could not bundle ${entry} (${err.code ?? err.message})`);
  }
}

// The one file that genuinely differs between the two scopes.
//
// An MCP `command` is spawned directly, with no shell, so an unexpanded
// `${CLAUDE_PLUGIN_ROOT}` would become part of the filename and the server
// would never start. The repo's own .mcp.json is read as PROJECT config, where
// nothing expands that placeholder, so it uses a path relative to the repo root.
// The installed plugin is read by the plugin loader, which does expand it — and
// must, because there the cwd is the user's project, not the plugin.
const mcpConfig = path.join(payload, '.mcp.json');
const config = JSON.parse(await readFile(mcpConfig, 'utf8'));
config.mcpServers.eklavya.args = ['${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs', 'server'];
await writeFile(mcpConfig, `${JSON.stringify(config, null, 2)}\n`);

console.log('assets copied to dist/');
