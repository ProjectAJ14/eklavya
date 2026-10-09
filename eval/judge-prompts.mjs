/**
 * The judge prompts the question eval and the GEPA pilot share, so a candidate is
 * judged by exactly the wording the baseline eval uses.
 */

/** The audit prompt: the judge sees the code (when the writer did) and the keyed answer. */
export function auditPrompt(q, item) {
  return [
    'You are auditing one multiple-choice question written for a developer who watched an agent write the code below. Be strict and answer only with JSON.',
    '',
    `Concept: ${q.slug} -- ${item.description ?? ''}`,
    `Tier asked for: ${q.tier_to_ask} (1 recall, 2 mechanism, 3 judgement, 4 failure modes, 5 design)`,
    '',
    item.code_shown
      ? 'Code the question writer was shown:'
      : 'Code the question writer was NOT shown (this focus withholds it on purpose); it is here only so you can judge the concept:',
    '```ts',
    item.diff ?? '(no code for this fixture)',
    '```',
    '',
    `Question: ${q.stem}`,
    ...q.options.map(
      (o, i) => `  ${i + 1}. ${o}${q.descriptions?.[i] ? ` -- ${q.descriptions[i]}` : ''}${i + 1 === q.correct ? '   <- marked correct' : ''}`,
    ),
    '',
    'Answer with exactly this JSON:',
    '{"answerable": true|false, "answerable_why": "...",',
    ' "correct_is_correct": true|false, "correct_why": "...",',
    ' "plausible_distractors": <0-3>, "distractors_why": "...",',
    ' "defensible_distractors": <0-3>, "defensible_why": "...",',
    ' "tier_match": "below"|"match"|"above", "tier_why": "...",',
    ' "one_idea": true|false}',
    '',
    '"answerable": could someone who understands the concept answer from what is shown.',
    '"correct_is_correct": is the option marked correct actually the right answer.',
    '"plausible_distractors": how many of the three wrong options a competent person could believe.',
    '"defensible_distractors": how many of the three wrong options an expert could argue ALSO answer the question correctly. Should be 0; any other number means a learner can be marked wrong for a right answer.',
  ].join('\n');
}

/**
 * The judge prompt for a reader with no context.
 *
 * No diff, no concept description, and no "watched the agent" framing: those
 * are what made the main judge's `answerable` pass on stems like "Task 6 moves
 * an instruction from SessionStart to UserPromptSubmit" that a real learner
 * could not place. Which option is keyed is withheld too, so the judge reads
 * the question the way the learner does, before knowing the answer.
 */
export function coldPrompt(q) {
  return [
    'You are auditing one multiple-choice question. The reader is a developer who has seen NONE of the code, plan, task list or conversation that prompted it. They see only the text below. Be strict and answer only with JSON.',
    '',
    `Question: ${q.stem}`,
    ...q.options.map((o, i) => `  ${i + 1}. ${o}${q.descriptions?.[i] ? ` -- ${q.descriptions[i]}` : ''}`),
    '',
    'Answer with exactly this JSON:',
    '{"answerable_cold": true|false, "answerable_cold_why": "...", "unexplained_names": ["..."]}',
    '',
    '"answerable_cold": could a developer who understands the underlying concept pick the right option from this text alone. False when the question relies on a name, label, document, file or event the text does not explain (for example "Task 6", "the brief", "the plan", a component nickname), when the right option depends on something only the author observed, or when the options are too terse to state a claim.',
    '"unexplained_names": every project-specific name the reader would need explained to answer. General technical terms (HTTP, SQLite, a well-known library) do not count. Empty when there are none.',
  ].join('\n');
}
