/**
 * The settings line: gone from the question, still stripped from the record.
 *
 * Eklavya used to print a bracketed line above every question naming the dials
 * that chose it -- `[mode: ambient · focus: concept · level: easy · tier: 2
 * mechanism]`. It was composed here and pasted into the `question` field of
 * `AskUserQuestion`, and it existed for a real reason: on `concept` focus a
 * deliberately transferable question reads as a vague one, and on `easy` a
 * tier-2 question reads as Eklavya being shallow rather than as a runway the
 * developer is 37 answers into. Dials nobody can see make a well-pitched
 * question look like a badly written one.
 *
 * The dials now live in the status bar (`statusline.ts`), which meets that
 * requirement without spending four lines above every stem: ambient state
 * belongs somewhere ambient, and a bar is on screen when the question arrives
 * *and* the rest of the time. `askHeader` is deleted rather than deprecated --
 * a composer nothing calls is a composer that drifts.
 *
 * `stripAskHeader` stays, and has to stay for good. Every attempt recorded while
 * the line existed still has it baked into the stem, and `questionFingerprint`
 * (`store.ts`) hashes that text to make *never the same question twice* true. A
 * strip that stopped knowing the old shape would let every one of those rows
 * change fingerprint at once, and the whole back catalogue would come back round
 * as brand-new questions.
 */

/**
 * The settings line, matched exactly as Eklavya used to compose it.
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
 * It exists because `question` is what `questionFingerprint` hashes -- a settings
 * line inside the stem would make the same question look brand new every time the
 * level or the focus changed, which is precisely the failure migration 006 kept
 * the options out of the stem to avoid. Nothing composes the line any more, so
 * what it now guards is history plus a model that decides to invent one. The brackets are optional in the pattern
 * for the same reason the leading dials group is: older rows do not have them.
 */
const SETTINGS_LINE_BODY =
  String.raw`\[?[ \t]*(?:(?:mode:[ \t]*)?(?:off|ambient|enforced(?:[ \t]*\(gated\))?)[ \t]*·[ \t]*)?(?:focus:[ \t]*)?(?:project|concept|learn(?:[ \t]*[:(][^\n·\]]*)?)[ \t]*·[ \t]*(?:level:[ \t]*)?(?:easy|medium|hard)(?:[ \t]*\(pinned\))?[ \t]*·[ \t]*tier:?[ \t]*[1-5][^\n]*`;

const LEADING_LINE = new RegExp(String.raw`^[ \t]*${SETTINGS_LINE_BODY}\n+`, 'i');
const TRAILING_LINE = new RegExp(String.raw`\n[ \t]*${SETTINGS_LINE_BODY}$`, 'i');

export function stripAskHeader(question: string): string {
  return question.replace(LEADING_LINE, '').replace(TRAILING_LINE, '').trim();
}
