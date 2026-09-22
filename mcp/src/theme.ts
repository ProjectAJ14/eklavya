/**
 * The look of every byte the `eklavya` CLI prints to a terminal.
 *
 * Ported from talea's `src/theme.js` + `src/log.js`, deliberately: the two tools
 * share a website design system (the verdigris ramp in `web/public/tokens.css`,
 * identical in both repos), and their terminals should read as the same family.
 * Change the palette there and here together.
 *
 * Not for the host surfaces. The status bar (`statusline.ts`) and the session
 * banner are drawn by Claude Code, not a TTY, and gate their colour themselves.
 */

// NO_COLOR disables colour, FORCE_COLOR forces it (for `| less -R`), otherwise
// it follows the TTY -- so a pipe, a CI log and the test suite get no escapes.
export const useColor =
  process.env.NO_COLOR || process.env.TERM === 'dumb'
    ? false
    : process.env.FORCE_COLOR
      ? true
      : !!process.stdout.isTTY;

// COLORTERM is the only reliable signal for 24-bit colour. A terminal that does
// not understand `38;2;r;g;b` does not drop it -- it spills the parameters onto
// the line as text -- so everything else gets the basic-16 fallback.
const trueColor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '');

// [24-bit hex, basic-16 SGR]. The `--vd-*` steps and status colours of tokens.css.
const PALETTE = {
  green: ['#79D5C4', 96], // --vd-300, the accent: something worked
  aged: ['#199688', 36], // --vd-500: a path, a detail, a choice number
  amber: ['#E8920C', 33], // --warning: attention, not failure
  red: ['#E5484D', 31], // --error: failure
} as const;

type Colour = keyof typeof PALETTE;

function tint(name: Colour, s: string): string {
  if (!useColor) return s;
  const [hex, basic] = PALETTE[name];
  // Close with 39 (default foreground), never 0: a full reset also clears bold
  // and dim, so a colour nested in `dim()` would un-dim the rest of the line.
  if (!trueColor) return `\x1b[${basic}m${s}\x1b[39m`;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

export const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[22m` : s);
export const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);

export const paint = {
  ok: (s: string) => tint('green', s),
  aged: (s: string) => tint('aged', s),
  warn: (s: string) => tint('amber', s),
  fail: (s: string) => tint('red', s),
};

// All BMP, all in the fonts people run terminals in. The glyph carries the state
// without colour; colour is the redundant cue.
export const glyph = { ok: '▣', skip: '◌', fail: '▤', warn: '!', arrow: '→' };

export type Mark = 'ok' | 'skip' | 'fail' | 'warn';

const MARKS: Record<Mark, string> = {
  ok: paint.ok(glyph.ok),
  skip: paint.warn(glyph.skip),
  fail: paint.fail(glyph.fail),
  warn: paint.warn(glyph.warn),
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visibleWidth = (s: string) => [...s.replace(ANSI_RE, '')].length;
export const padEndVisible = (s: string, width: number) =>
  s + ' '.repeat(Math.max(0, width - visibleWidth(s)));

const out = (s = '') => process.stdout.write(`${s}\n`);

export const plain = out;
export const heading = (s: string) => out(`\n${bold(s)}\n`);

/**
 * One check row: `  ▣  label   detail`. A null mark is a continuation of the
 * row above -- same column, no glyph -- so a label is said once, not six times.
 */
export function check(mark: Mark | null, label: string, detail: string, width = 11): void {
  out(`  ${mark ? MARKS[mark] : ' '}  ${padEndVisible(label, width)} ${detail}`.trimEnd());
}

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/**
 * A check row that animates while `work` runs, then clears itself for the row
 * the caller prints with the result. A step that takes seconds and prints
 * nothing reads as a hang. Off a TTY there is nothing to animate: the label is
 * printed once, so a CI log still says what it was waiting on.
 *
 * Only animates through real async work -- a sync call blocks the timer, which
 * is why the import runs on a worker thread.
 */
export async function spin<T>(label: string, detail: string, work: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    out(`  ${dim('·')}  ${padEndVisible(label, 11)} ${dim(detail)}`);
    return work();
  }
  let i = 0;
  const draw = () =>
    process.stdout.write(`\r\x1b[2K  ${paint.aged(FRAMES[i++ % FRAMES.length]!)}  ${padEndVisible(label, 11)} ${dim(detail)}`);
  draw();
  const timer = setInterval(draw, 80);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  }
}

/** The closing line: what the run means, in one sentence. */
export function verdict(trouble: string | null, clear: string): void {
  out('');
  if (trouble) out(`${paint.warn(glyph.fail)} ${bold(paint.warn(trouble))}`);
  else out(`${paint.ok(glyph.ok)} ${bold(paint.ok(clear))}`);
}
