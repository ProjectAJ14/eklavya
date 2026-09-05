// Copies non-TypeScript runtime assets (SQL migrations, seed graphs) into dist/
// so the built server resolves them the same way it does when run from src via tsx.
import { cp, mkdir, rm } from 'node:fs/promises';
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

// The user-level skill travels the same way, for the same reason: `eklavya
// install` copies it into ~/.claude/skills/, so it must be in the tarball. It
// is deliberately NOT under skills/ — that whole directory becomes the plugin
// payload below, and shipping this skill through both routes would register it
// twice in the same session.
const userSkill = path.join(path.dirname(root), 'user-skill');
try {
  await cp(userSkill, path.join(root, 'dist', 'user-skill'), { recursive: true });
} catch (err) {
  console.warn(`warning: could not bundle the user-level skill (${err.code ?? err.message})`);
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

// NOTE: .mcp.json is copied verbatim, and must be.
//
// Both install routes ship the repo's copy: the marketplace clones this
// repository and serves it as the plugin, and the npm payload copies the same
// tree. An earlier version rewrote the path here for the payload and left a
// repo-relative one behind for git installs, which gave every marketplace user
// an MCP server that could not resolve its own entry point. One file, one
// shape, `${CLAUDE_PLUGIN_ROOT}` — expanded by the plugin loader in both cases.

console.log('assets copied to dist/');
