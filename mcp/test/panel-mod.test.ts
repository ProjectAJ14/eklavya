import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(repo, ...p), 'utf8');
const model = read('hooks', 'panel', 'model.ts');

/**
 * The quiz panel is a Claude Code mod: it has no filesystem, so a few things
 * are copied into it rather than read. Each copy is pinned to its source here,
 * so one cannot change and leave the other behind.
 */
describe('the panel mod keeps its copies in step with their sources', () => {
  it('grades typed answers on the rubric rows of grading.md, verbatim', () => {
    const grading = read('skills', 'tutor', 'references', 'grading.md');
    const rows = /export const RUBRIC = \[([\s\S]*?)\]\.join/.exec(model)![1]!;
    const copied = [...rows.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\u2014/g, '—').replace(/\\'/g, "'"));
    expect(copied).toHaveLength(6);
    for (const row of copied) {
      const [grade, means] = row.split(' | ') as [string, string];
      // grading.md's table is `| 3 | correct, but hesitant ... |`
      expect(grading, row).toContain(`| ${grade} | ${means} |`);
    }
  });

  it('names tiers the way the dashboard does', () => {
    const dashboard = read('mcp', 'src', 'assets', 'dashboard.html');
    const shown = /const TIER = (\{[^}]*\});/.exec(dashboard)![1]!;
    const mod = /export const TIER: Record<number, string> = (\{[^}]*\})/.exec(model)![1]!;
    const norm = (s: string) => s.replace(/\s+/g, '').replace(/'/g, '"').replace(/(\d):/g, '"$1":');
    expect(JSON.parse(norm(mod))).toEqual(JSON.parse(norm(shown)));
  });

  it('opens with the reopen command the notice names, and the pane id the render hook matches', () => {
    const register = read('hooks', 'panel', 'register.tsx');
    expect(model).toContain("export const REOPEN = '/eklavya-panel'");
    expect(register).toContain("name: 'eklavya-panel'");
    expect(model).toContain("export const PANE = 'eklavya-quiz'");
    // The validator needs the matcher's id as a literal, so the one place it is spelled twice is pinned.
    expect(register).toContain("requestId: 'eklavya-quiz'");
  });

  it('is declared as a module beside the command hooks, with its state contract in the manifest', () => {
    const hooks = JSON.parse(read('hooks', 'hooks.json'));
    expect(hooks.modules).toEqual(['./panel/register.tsx']);
    expect(Object.keys(hooks.hooks).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(repo, 'hooks', 'panel', 'register.tsx'))).toBe(true);
    const manifest = JSON.parse(read('.claude-plugin', 'plugin.json'));
    expect(manifest.types).toBe('./hooks/panel/types/index.d.ts');
    expect(fs.existsSync(path.join(repo, manifest.types))).toBe(true);
    // The contract names the plugin, as every $.state reference in the mod does.
    expect(read('hooks', 'panel', 'types', 'index.d.ts')).toMatch(/PluginState \{\s*eklavya: \{ quiz: PanelState \}/);
    expect(read('hooks', 'panel', 'register.tsx')).toContain("{ plugin: 'eklavya', key: 'quiz' }");
  });

  it('ships in the npm payload, without its own tests', () => {
    const shipped = path.join(repo, 'mcp', 'dist', 'plugin', 'hooks', 'panel');
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));
    expect(files(shipped).sort()).toEqual(['model.ts', 'register.tsx', 'types/index.d.ts']);
    expect(fs.readFileSync(path.join(repo, 'mcp', 'dist', 'plugin', 'hooks', 'hooks.json'), 'utf8')).toContain('./panel/register.tsx');
  });

  it('calls only tools the server registers, by their real names and fields', () => {
    const register = read('hooks', 'panel', 'register.tsx');
    const tools = read('mcp', 'src', 'tools', 'panel_tools.ts');
    for (const tool of ['panel_sync', 'panel_answer', 'present_question']) {
      expect(tools).toContain(`name: '${tool}'`);
    }
    for (const called of [...register.matchAll(/call\(\$, '(\w+)'/g)].map((m) => m[1]!)) {
      expect(tools, called).toContain(`name: '${called}'`);
    }
    expect(register).toMatch(/__present_question\$/);
  });
});
