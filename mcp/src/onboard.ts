/**
 * The dials, one at a time, every time `eklavya install` runs.
 *
 * There is no "onboarded" flag, on purpose: a first run and a tenth run are the
 * same walk. Each step marks what is set now, Enter (or "next") keeps it, and a
 * number or a name changes it. A first install is five Enters to the defaults;
 * a re-install is how you see what you chose and tweak one thing.
 *
 * Without a terminal (CI, a pipe, the test suite) nothing is asked: the settings
 * are printed and left as they are.
 *
 * Input is read through readline, never `fs.readSync(0)`. After `npm install -g`
 * the inherited stdin is often non-blocking, a sync read throws EAGAIN, and the
 * old installer took that as "no terminal" — printing a question and answering
 * it itself.
 */
import readline from 'node:readline/promises';
import { globalConfigPath } from './paths.js';
import { loadConfig, loadGlobalConfig, readConfigFile, writeConfigFile, type EklavyaConfig } from './config.js';
import { bold, check, dim, glyph, paint, plain } from './theme.js';

export type MemoryOwner = 'eklavya' | 'claude-mem';

type Option = { value: string; detail: string };
type Step = { key: string; title: string; current: string; options: Option[] };

function steps(c: EklavyaConfig, claudeMem: boolean): Step[] {
  return [
    {
      key: 'quiz',
      title: 'how hard it pushes',
      current: !c.quiz.enabled ? 'off' : c.quiz.enforced ? 'enforced' : 'on',
      options: [
        { value: 'on', detail: 'questions while you work, always skippable' },
        { value: 'enforced', detail: 'commits wait until the session quiz passes' },
        { value: 'off', detail: 'no questions — memory is its own step' },
      ],
    },
    {
      key: 'focus',
      title: 'what it teaches',
      current: c.focus,
      options: [
        { value: 'concept', detail: 'the transferable idea behind the code' },
        { value: 'project', detail: 'this codebase — the code just written' },
        { value: 'learn', detail: 'a topic you name, taught through your code' },
      ],
    },
    {
      key: 'cadence',
      title: 'when it asks',
      current: c.cadence,
      options: [
        { value: 'interleaved', detail: 'one question at a time while the agent works' },
        { value: 'end', detail: 'a batch once the agent is done' },
      ],
    },
    {
      key: 'difficulty',
      title: 'how hard the questions get',
      current: c.difficulty,
      options: [
        { value: 'auto', detail: 'starts easy, climbs on good answers, per project' },
        { value: 'easy', detail: 'pinned — never climbs' },
        { value: 'medium', detail: 'pinned' },
        { value: 'hard', detail: 'pinned' },
      ],
    },
    claudeMem
      ? {
          key: 'memory',
          title: 'Claude Mem is installed too — only one should record',
          current: c.memory.enabled ? 'eklavya' : 'claude-mem',
          options: [
            { value: 'eklavya', detail: "import Claude Mem's history, then uninstall it" },
            { value: 'claude-mem', detail: 'keep it; Eklavya records nothing, quizzes stay on' },
          ],
        }
      : {
          key: 'memory',
          title: 'record sessions, recall them next time',
          current: c.memory.enabled ? 'on' : 'off',
          options: [
            { value: 'on', detail: 'local only — nothing leaves this machine' },
            { value: 'off', detail: 'nothing recorded; quizzes unaffected' },
          ],
        },
  ];
}

/** An answer to a step: its value, or undefined when it names nothing. */
export function pick(step: Pick<Step, 'current' | 'options'>, answer: string): string | undefined {
  const a = answer.trim().toLowerCase();
  if (!a || a === 'next' || a === 'keep') return step.current;
  const n = Number(a);
  if (Number.isInteger(n)) return step.options[n - 1]?.value;
  const hits = step.options.filter((o) => o.value.startsWith(a));
  return hits.length === 1 ? hits[0]!.value : undefined;
}

function render(step: Step, at: number, total: number): void {
  const width = Math.max(...step.options.map((o) => o.value.length));
  plain('');
  plain(`${dim(`${at}/${total}`)}  ${bold(step.key)}  ${dim(step.title)}`);
  step.options.forEach((o, i) => {
    const on = o.value === step.current;
    const mark = on ? paint.ok(glyph.ok) : dim(glyph.skip);
    const label = o.value.padEnd(width);
    plain(`  ${mark}  ${paint.aged(String(i + 1))}  ${on ? bold(label) : label}  ${dim(o.detail)}`);
  });
}

/**
 * Walks the dials and writes what changed to the global config. Returns who
 * records memory when Claude Mem is present — acting on that is install's job —
 * and null otherwise.
 */
export async function onboard(opts: {
  claudeMem: boolean;
  memoryFlag: MemoryOwner | null;
  hookScript: string;
}): Promise<MemoryOwner | null> {
  const before = loadGlobalConfig();
  const list = steps(before, opts.claudeMem);
  const chosen: Record<string, string> = Object.fromEntries(list.map((s) => [s.key, s.current]));
  const memoryFixed = opts.claudeMem && opts.memoryFlag !== null;
  if (memoryFixed) chosen.memory = opts.memoryFlag!;
  let topic = before.focus_topic;

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (tty) {
    plain(`\n${bold('Your settings')}  ${dim('Enter keeps the marked one · a number or name changes it')}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => {
      plain('');
      process.exit(130);
    });
    try {
      for (const [i, step] of list.entries()) {
        if (step.key === 'memory' && memoryFixed) continue;
        render(step, i + 1, list.length);
        let value: string | undefined;
        while ((value = pick(step, await rl.question(`  ${glyph.arrow} `))) === undefined) {
          plain(dim(`  1–${step.options.length}, a name, or Enter to keep`));
        }
        chosen[step.key] = value;
        if (step.key === 'focus' && value === 'learn') {
          const t = (await rl.question(`  topic${topic ? dim(` [${topic}]`) : ''} ${glyph.arrow} `)).trim();
          topic = t || topic;
          if (!topic) {
            chosen.focus = step.current === 'learn' ? 'concept' : step.current;
            plain(dim(`  learn needs a topic — kept ${chosen.focus}`));
          }
        }
      }
    } catch {
      // Ctrl-D closes the input: whatever was not answered keeps its value.
      plain('');
    } finally {
      rl.close();
    }
  } else if (opts.claudeMem && !memoryFixed) {
    // Nobody to ask: the choice that touches nothing of theirs.
    chosen.memory = 'claude-mem';
  }

  const patch: Record<string, unknown> = {};
  if (chosen.quiz !== list[0]!.current) {
    patch.quiz = { enabled: chosen.quiz !== 'off', enforced: chosen.quiz === 'enforced' };
  }
  if (chosen.focus !== before.focus || (chosen.focus === 'learn' && topic !== before.focus_topic)) {
    patch.focus = chosen.focus;
    if (chosen.focus === 'learn') patch.focus_topic = topic;
  }
  if (chosen.cadence !== before.cadence) patch.cadence = chosen.cadence;
  if (chosen.difficulty !== before.difficulty) patch.difficulty = chosen.difficulty;
  // With Claude Mem present, install owns the memory switch: it depends on
  // whether the import succeeds.
  if (!opts.claudeMem && (chosen.memory === 'on') !== before.memory.enabled) {
    const memory = (readConfigFile(globalConfigPath()).memory ?? {}) as Record<string, unknown>;
    patch.memory = { ...memory, enabled: chosen.memory === 'on' };
  }
  if (Object.keys(patch).length) writeConfigFile(globalConfigPath(), patch);

  plain('');
  for (const step of list) {
    const value = chosen[step.key]!;
    const shown = step.key === 'focus' && value === 'learn' ? `learn ${dim(`· ${topic ?? 'no topic'}`)}` : value;
    check('ok', step.key, value === step.current ? shown : `${shown} ${dim('— changed')}`);
  }
  if (chosen.quiz === 'enforced') {
    check(null, '', dim(`gate commits made outside Claude Code too: ${opts.hookScript}, in each repo`));
  }
  check(null, '', dim(Object.keys(patch).length ? `settings saved to ${globalConfigPath()}` : 'settings unchanged'));
  if (!tty) check(null, '', dim('change them: eklavya install in a terminal, or eklavya config set'));

  // Run from inside a checkout with its own settings, the walk above is not
  // what applies here — say so, rather than let a global "concept" hide a
  // project pinned to "project".
  const here = loadConfig();
  const after = loadGlobalConfig();
  const dial = (c: EklavyaConfig): Record<string, unknown> => ({
    quiz: `${c.quiz.enabled}/${c.quiz.enforced}`,
    focus: c.focus,
    cadence: c.cadence,
    difficulty: c.difficulty,
    memory: c.memory.enabled,
  });
  const [mine, global] = [dial(here.config), dial(after)];
  const pinned = Object.keys(mine).filter((k) => mine[k] !== global[k]);
  if (pinned.length && here.projectPath) {
    check('warn', 'project', `this checkout overrides ${pinned.join(', ')} ${dim(`— ${here.projectPath}`)}`);
  }

  return opts.claudeMem ? (chosen.memory as MemoryOwner) : null;
}
