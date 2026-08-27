/**
 * The footer that says which settings asked the question.
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
 * So it is a line under the stem. Composed here rather than by whoever writes the
 * question, for the same reason `tier_to_ask`, `answer_position` and
 * `format_to_use` are: a string each question assembles for itself is a string
 * that drifts, and this one has to be identical every time or it stops being a
 * readout and becomes decoration.
 */
import type { EklavyaConfig } from './config.js';
import type { Level } from './srs.js';

/** Blank line between stem and footer, so the two never read as one sentence. */
export const FOOTER_GAP = '\n\n';

export interface AskFooterInput {
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
 * the end -- already tells them when Eklavya asks, and a footer that repeats what
 * the moment just demonstrated is noise. Everything else is here: the mode, the
 * focus, the level, what the tier is asking for, and how many questions are
 * coming. A learner who cannot see those is answering a question with no idea
 * why it was pitched where it was, or whether four more follow.
 */
export function askFooter({ config, level, pinned, tier, position }: AskFooterInput): string | null {
  if (config.quiet) return null;

  const focus =
    config.focus === 'learn' && config.focus_topic
      ? `learn: ${config.focus_topic}`
      : config.focus;

  const label = TIER_LABEL[tier];
  const parts = [
    // `enforced` is the one value with a consequence attached, so it says so.
    config.mode === 'enforced' ? 'enforced (gated)' : config.mode,
    focus,
    // A pinned level explains itself here or nowhere: without it, questions
    // simply stop getting harder one day and nothing on screen says why.
    pinned ? `${level} (pinned)` : level,
    label ? `tier ${tier} ${label}` : `tier ${tier}`,
  ];
  if (position && position.total > 1) parts.push(`q ${position.index}/${position.total}`);

  return parts.join(' · ');
}

/**
 * A trailing footer line, matched exactly as `askFooter` composes it.
 *
 * Strict, anchored to the end, and one line only, so it can never eat a real
 * stem. It exists because the tutor will eventually record the whole block it
 * displayed, and `question` is what `questionFingerprint` hashes -- a footer
 * inside the stem would make the same question look brand new every time the
 * level or the focus changed, which is precisely the failure migration 006 kept
 * the options out of the stem to avoid.
 */
const FOOTER_LINE =
  /\n[ \t]*(?:(?:off|ambient|enforced(?:[ \t]*\(gated\))?)[ \t]*·[ \t]*)?(?:project|concept|learn(?::[^\n·]*)?)[ \t]*·[ \t]*(?:easy|medium|hard)(?:[ \t]*\(pinned\))?[ \t]*·[ \t]*tier[ \t]*[1-5][^\n]*$/i;

export function stripAskFooter(question: string): string {
  return question.replace(FOOTER_LINE, '').trimEnd();
}
