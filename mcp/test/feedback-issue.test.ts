import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');

/**
 * The form is read as the small, fixed-shape file it is: one block per
 * `- type:`, with the keys this test checks at known indents. A change of shape
 * fails here and is read by a person; the whole file is also parsed as YAML
 * when the manual's tooling builds.
 */
function blocks(text: string) {
  return text
    .split(/^ {2}- type: /m)
    .slice(1)
    .map((b) => {
      const type = b.split('\n')[0]!.trim();
      const get = (re: RegExp) => re.exec(b)?.[1]?.trim().replace(/^"|"$/g, '');
      return {
        type,
        id: get(/^ {4}id: (.+)$/m),
        label: get(/^ {6}label: (.+)$/m),
        required: get(/^ {6}required: (.+)$/m),
        options: [...b.matchAll(/^ {8}- (.+)$/gm)].map((m) => m[1]!.trim()),
      };
    });
}

describe('the GitHub issue form', () => {
  const form = read('.github/ISSUE_TEMPLATE/eklavya-feedback.yml');
  const fields = blocks(form).filter((b) => b.id);

  it('names itself, prefixes the title and keeps blank issues open', () => {
    expect(form).toMatch(/^name: Eklavya feedback$/m);
    expect(form).toMatch(/^title: "\[feedback\] "$/m);
    expect(read('.github/ISSUE_TEMPLATE/config.yml').trim()).toBe('blank_issues_enabled: true');
  });

  it('has the seven fields, in order, with the right kinds and required flags', () => {
    expect(fields.map((f) => [f.id, f.type, f.required])).toEqual([
      ['category', 'dropdown', 'true'],
      ['what', 'textarea', 'true'],
      ['expected', 'textarea', 'true'],
      ['concept', 'input', 'false'],
      ['version', 'input', 'true'],
      ['environment', 'input', 'false'],
      ['example', 'textarea', 'false'],
    ]);
  });

  it('offers the six categories', () => {
    const [category] = fields;
    expect(category!.options).toEqual(['Question quality', 'Grading', 'Tutor behaviour', 'Dashboard', 'Install and updates', 'Other']);
  });
});

describe('the skill drafts the same issue', () => {
  const skill = read('user-skill/eklavya/SKILL.md');
  const raw = skill.slice(skill.indexOf('## Feedback about Eklavya'), skill.indexOf('## Rules'));
  // Prose is wrapped at 80 columns; what matters is the words.
  const section = raw.replace(/\s+/g, ' ');
  const fields = blocks(read('.github/ISSUE_TEMPLATE/eklavya-feedback.yml')).filter((b) => b.id);

  it('triggers on a wrong question, a bad grade or a bug in Eklavya', () => {
    const description = /^description: "(.+)"$/m.exec(skill)![1]!;
    expect(description).toContain('a wrong or confusing question, a bad grade, or a bug in Eklavya');
    expect(description).toMatch(/^Operate Eklavya/);
  });

  it('has the section, and it names every form heading in order', () => {
    expect(section.length).toBeGreaterThan(500);
    let at = 0;
    for (const f of fields) {
      const i = raw.indexOf(`### ${f.label}`, at);
      expect(i, f.label).toBeGreaterThan(-1);
      at = i;
    }
  });

  it('never files without a yes to the exact text on screen', () => {
    expect(section).toContain('"Post this to ProjectAJ14/eklavya?"');
    expect(section).toContain('No issue is created without a clear yes to the exact text on screen');
    expect(section).toMatch(/A "no" posts nothing/);
    expect(skill.slice(skill.indexOf('## Rules')).replace(/\s+/g, ' ')).toMatch(/Never create a GitHub issue.*clear yes to the exact title and body/);
  });

  it('strips paths, project names, secrets and project code, and never attaches eklavya data', () => {
    for (const token of ['`<path>`', '`<project>`', '`<redacted>`', 'repository and project names', 'hostnames', 'secret', "code from the user's project", '~/.eklavya/']) {
      expect(section, token).toContain(token);
    }
  });

  it('checks that it can file before it asks, and skips the question when it cannot', () => {
    expect(section).toMatch(/Before you ask, check whether you can file: run `gh auth status`/);
    expect(section).toMatch(/If neither works, do not ask: print the draft and the prefilled link \(step 6\)/);
    expect(section.indexOf('Before you ask')).toBeLessThan(section.indexOf('Post this to ProjectAJ14/eklavya?'));
  });

  it('files with gh and a temporary body file, or falls back to a draft and a prefilled link', () => {
    expect(section).toContain('gh auth status');
    expect(section).toContain('gh issue create --repo ProjectAJ14/eklavya --title "<title>" --body-file <file>');
    expect(section).toMatch(/delete the file afterwards/);
    expect(section).toContain('GitHub MCP tool is the second choice');
    expect(section).toContain('https://github.com/ProjectAJ14/eklavya/issues/new?template=eklavya-feedback.yml&title=<urlencoded>');
    for (const f of fields) expect(section, f.id).toContain(`${f.id}=<urlencoded>`);
    expect(section).toContain('6,000 characters');
    expect(section).toMatch(/nothing was posted/);
  });
});
