/**
 * The line that says which settings asked the question.
 *
 * Eklavya has four dials, and at the one moment they decide what the developer
 * is looking at -- a question on screen -- every one of them used to be
 * invisible. That is not cosmetic. On `concept` focus a deliberately transferable
 * question reads as a vague one, so the developer answers about their own file,
 * gets marked down, and concludes the quiz is badly written. On `easy` a tier-2
 * question reads as Eklavya being shallow rather than as a runway they are 37
 * answers into -- and the entire engagement argument for levels rests on that
 * runway being seen.
 *
 * It cannot go in the `AskUserQuestion` header: that caps at 12 characters and is
 * already spent on `Eklavya`, the only thing on screen saying who is asking
 * (1.4.1). Trading attribution for settings would reopen the bug that fixed --
 * an unattributed question mid-task reads as the agent going off-piste.
 *
 * So it is a line above the stem, in brackets. Both halves of that were learned
 * the hard way. Below the stem it read as a fourth line of the question -- you
 * finish "tier 2 mechanism" still looking for the thing being asked -- because
 * `AskUserQuestion` draws the whole `question` field in one bold weight and gives
 * us nothing to separate a readout from prose. Markdown is not parsed in that
 * field either: backticks and asterisks come through as literal characters, so
 * there is no dim to reach for. Brackets are what is left, and they are what a
 * terminal already uses to mean *metadata, not prose* -- log levels, build tags,
 * branch names. Raw ANSI would survive neither the JSON hop nor a non-terminal
 * renderer, so it is not an option.
 *
 * Every part names its dial: `[mode: ambient · focus: concept · level: easy ·
 * tier: 1 recall]`. The unlabelled form it replaced was four bare values in a
 * row, which only reads as a settings line to someone who already knows there
 * are four dials and what order they come in -- and the whole point of the line
 * is the reader who does not. Four words with no keys is a readout you have to
 * be taught to read, which is exactly the state it was added to fix.
 *
 * Composed here rather than by whoever writes the question, for the same reason
 * `tier_to_ask`, `answer_position` and `format_to_use` are: a string each
 * question assembles for itself is a string that drifts, and this one has to be
 * identical every time or it stops being a readout and becomes decoration.
 */
import type { EklavyaConfig } from './config.js';
import type { Level } from './srs.js';

export interface AskHeaderInput {
  config: EklavyaConfig;
  level: Level;
  /** True when `difficulty` pins the level, so progression is switched off. */
  pinned: boolean;
  /** The tier this specific question is asked at. */
  tier: number;
  /** Where this question sits in the plan, when the plan holds more than one. */
  position?: { index: number; total: number };
}

/** What each tier is actually asking for, so `tier 4` is not a bare number. */
const TIER_LABEL: Record<number, string> = {
  1: 'recall',
  2: 'mechanism',
  3: 'judgement',
  4: 'failure modes',
  5: 'design',
};

/**
 * `null` when nothing should be shown.
 *
 * `quiet` is the only suppressor: someone who turned the narration off has
 * already answered this question.
 *
 * `cadence` is deliberately absent. The question's *arrival* -- mid-task or at
 * the end -- already tells them when Eklavya asks, and a line that repeats what
 * the moment just demonstrated is noise. Everything else is here: the mode, the
 * focus, the level, what the tier is asking for, and how many questions are
 * coming. A learner who cannot see those is answering a question with no idea
 * why it was pitched where it was, or whether four more follow.
 */
export function askHeader({ config, level, pinned, tier, position }: AskHeaderInput): string | null {
  if (config.quiet) return null;

  // `learn (topic)` rather than `learn: topic`: the value now sits behind its own
  // `focus:` label, and two colons in one field read as a nested key.
  const focus =
    config.focus === 'learn' && config.focus_topic
      ? `learn (${config.focus_topic})`
      : config.focus;

  const label = TIER_LABEL[tier];
  const parts: [string, string][] = [
    // `enforced` is the one value with a consequence attached, so it says so.
    ['mode', config.mode === 'enforced' ? 'enforced (gated)' : config.mode],
    ['focus', focus],
    // A pinned level explains itself here or nowhere: without it, questions
    // simply stop getting harder one day and nothing on screen says why.
    ['level', pinned ? `${level} (pinned)` : level],
    ['tier', label ? `${tier} ${label}` : String(tier)],
  ];
  if (position && position.total > 1) parts.push(['question', `${position.index} of ${position.total}`]);

  return `[${parts.map(([key, value]) => `${key}: ${value}`).join(' · ')}]`;
}

/**
 * The settings line, matched exactly as `askHeader` composes it.
 *
 * Anchored to the start or the end of the stem, one line only, and strict enough
 * about the shape -- mode, focus, level, tier, in that order -- that it can never
 * eat a real question. Both positions are matched because the line moved from the
 * bottom to the top in 1.9, and stems recorded before that are still in the
 * database; a strip that only knew the new position would let every old row's
 * fingerprint drift. The `key:` labels are optional in the pattern for the same
 * reason: rows recorded before the line was labelled are still the same
 * questions, and a strip that only knew the labelled shape would leave the old
 * line baked into every one of their fingerprints.
 *
 * It exists because the tutor will eventually record the whole block it
 * displayed, and `question` is what `questionFingerprint` hashes -- a settings
 * line inside the stem would make the same question look brand new every time the
 * level or the focus changed, which is precisely the failure migration 006 kept
 * the options out of the stem to avoid. The brackets are optional in the pattern
 * for the same reason the leading dials group is: older rows do not have them.
 */
const SETTINGS_LINE_BODY =
  String.raw`\[?[ \t]*(?:(?:mode:[ \t]*)?(?:off|ambient|enforced(?:[ \t]*\(gated\))?)[ \t]*·[ \t]*)?(?:focus:[ \t]*)?(?:project|concept|learn(?:[ \t]*[:(][^\n·\]]*)?)[ \t]*·[ \t]*(?:level:[ \t]*)?(?:easy|medium|hard)(?:[ \t]*\(pinned\))?[ \t]*·[ \t]*tier:?[ \t]*[1-5][^\n]*`;

const LEADING_LINE = new RegExp(String.raw`^[ \t]*${SETTINGS_LINE_BODY}\n+`, 'i');
const TRAILING_LINE = new RegExp(String.raw`\n[ \t]*${SETTINGS_LINE_BODY}$`, 'i');

export function stripAskHeader(question: string): string {
  return question.replace(LEADING_LINE, '').replace(TRAILING_LINE, '').trim();
}
