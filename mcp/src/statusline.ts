/**
 * The dials, in the status bar.
 *
 * These four used to be printed above every question, as `ask_header` — a
 * bracketed settings line composed in `ask.ts` and pasted into the `question`
 * field of `AskUserQuestion`. That was the second attempt at the same problem
 * and it fixed the real bug: on `concept` focus a deliberately transferable
 * question reads as a vague one, and on `easy` a tier-2 question reads as
 * Eklavya being shallow rather than as a runway the developer is 37 answers
 * into. Invisible dials make a well-pitched question look like a bad one.
 *
 * But the fix was in the wrong place. The dials are ambient state — they are
 * true for the whole session, not for one question — so restating them above
 * every stem paid the cost of a readout on every single question, and put four
 * lines of settings between the developer and the thing being asked. A status
 * bar is where ambient state belongs: it is on screen at the moment a question
 * arrives, which was the entire requirement, and it is on screen the rest of
 * the time too, for free.
 *
 * What that trade gives up, deliberately:
 *
 * - **The tier.** It is per-question, and a status bar refreshes on the host's
 *   cadence rather than ours, so a tier here would sometimes name the previous
 *   question's difficulty. A stale readout is worse than no readout. `level`
 *   stays, and it is the part that explained the pitch: `easy` already says
 *   tiers 1-2. The exact tier is still in the plan, still recorded on every
 *   attempt, and still in the dashboard.
 * - **`question: N of M`.** Same reason, and under the default `interleaved`
 *   cadence a plan is one question anyway, so it was rarely shown.
 *
 * `stripAskHeader` in `ask.ts` stays regardless, and must: rows recorded while
 * the settings line existed still have it baked into their stem, and the
 * fingerprint that makes *never the same question twice* true is computed from
 * that text.
 *
 * Labels are dropped here, and that is a real difference from `ask_header`,
 * which argued for them: four bare values only read as a settings line to
 * someone who already knows there are four dials. That argument holds for a
 * line seen once beside a question — every appearance might be a first — and
 * dissolves for a bar that is always there. You learn it once, and 47 characters
 * fits beside a directory and a branch where 74 does not.
 */
import type { EklavyaConfig } from './config.js';
import type { Level } from './srs.js';

export interface StatusLineInput {
  config: EklavyaConfig;
  level: Level;
  /** True when `difficulty` pins the level, so progression is switched off. */
  pinned: boolean;
  /** False to emit no ANSI, for a host that renders the string literally. */
  color?: boolean;
}

/** 256-colour approximations of the two ground-independent accents. */
const VERDIGRIS = 116;
const AMBER = 172;

// Written as escapes rather than literal ESC bytes: a raw control character in
// source is invisible in an editor and does not survive every copy-paste.
const ESC = '\u001b';

function paint(text: string, code: number, color: boolean): string {
  return color ? `${ESC}[38;5;${code}m${text}${ESC}[0m` : text;
}

/**
 * The bar segment, or `null` when Eklavya should say nothing at all.
 *
 * Two suppressors, and both mean the same thing as everywhere else in the
 * codebase: `mode: off` is dormant, and `quiet` is someone who turned the
 * narration off and has already answered this question.
 */
export function statusLine({ config, level, pinned, color = true }: StatusLineInput): string | null {
  if (config.mode === 'off' || config.quiet) return null;

  // `learn (topic)` rather than `learn: topic` — a colon in a bar reads as a
  // key, and the topic is a value with no key of its own here.
  const focus =
    config.focus === 'learn' && config.focus_topic
      ? `learn (${config.focus_topic})`
      : config.focus;

  const parts = [config.mode, focus, config.cadence, pinned ? `${level} (pinned)` : level];

  // `enforced` is the one dial value with a consequence attached — commits are
  // gated — so the whole segment takes the warning colour rather than the
  // accent. The word is still there, so colour is a redundant cue and not the
  // only one: a bar rendered without ANSI loses nothing but the emphasis.
  const code = config.mode === 'enforced' ? AMBER : VERDIGRIS;
  return paint(`[EKLAVYA ${parts.join(' · ')}]`, code, color);
}
