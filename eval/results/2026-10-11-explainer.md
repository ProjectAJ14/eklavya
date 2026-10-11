# Explainer page eval, 2026-10-11

Harness: `eval/explainer-harness.mjs`, scorer `mcp/src/eval/explainer-score.ts`, at
`feat/explainer-eval-clarity` (code from `5e7f638`). Claude Code 2.1.296, default model for
the agent and the judge. 10 cases (`eval/fixtures/explainer/cases.json`) × 3 trials per run,
4 workers. Artifact skill **off** in the two main runs: the agent read only
`agents/explainer.md`, so they measure the agent file, not the installed `eklavya-artifacts`
skill. A third, smaller run (1 trial per case) used the candidate with the skill **on**, as an
installed user has it. Raw results: `2026-10-11-explainer-baseline.json`,
`2026-10-11-explainer-candidate.json` (with the pairwise verdicts) and
`2026-10-11-explainer-candidate-skill.json`.

- **Baseline:** `agents/explainer.md` as on `main` @ `5e7f638`.
- **Candidate:** the same file with two changes. The short answer gets a fixed shape: what it
  does, what that means for the code in the question, and optionally its name, with detail
  moved under "How it works". Comparisons with other languages are made only when sure, and
  a guarantee is stated no more strongly than the page later supports.

## Results

| | Baseline | Candidate | Candidate, skill on |
|---|---|---|---|
| Pages written, opened, path replied | 30/30 | 30/30 | 10/10 |
| Pass every gate | 13/30 | 26/30 | 9/10 |
| Failed `short_answer_brief` (over three sentences) | 17 | 3 | 1 |
| Failed any other gate | 0 | 1 (`options_verbatim`) | 0 |
| Judge: short answer a newcomer could repeat | 14/30 | 28/29 | 10/10 |
| Judge: misconception in the actual answer named | 24/24 | 23/23 | 8/8 |
| Judge: clarity, 1–5 (mean) | 4.7 | 4.9 | 4.8 |
| Blind pairwise, page left the reader better able to explain and predict | 13 wins | 17 wins, 0 ties | not run |
| Page words (mean, diagrams excluded) | 648 | 761 | 697 |
| Figures per page (mean) | 1.0 | 1.1 | 1.3 |
| Time to the path line (mean) | 47 s | 52 s | 55 s |
| Agent tokens (in / cached / out), list price | 1.95M / 1.44M / 149k, $7.35 | 1.93M / 1.43M / 163k, $7.59 | 711k / 575k / 56k, $2.33 |
| Judge tokens, per-page score | 144k / 65k / 15k, $0.95 | 144k / 63k / 13k, $0.91 | 43k / 19k / 5k, $0.29 over 9 calls, plus 1 call on re-score whose tokens were not recorded |
| Judge tokens, pairwise (30 calls) | n/a | 175k / 65k / 8k, $1.06 | n/a |

`short_answer_brief` was added after the baseline run, when every one of the judge's "could
not repeat" verdicts gave the same reason: the short answer ran four to eight sentences
against the agent file's own "two or three". The baseline was re-scored with it, reusing the
saved judge verdicts. The judge ran on pages that passed every gate except this one: 30 in the
baseline and 29 in the candidate. The candidate page that failed `options_verbatim` was not
judged.

Two of the candidate's three short-answer misses are on the Rust case (four sentences each), and the third is on the ETag page someone asked for. A later one-trial check of the Rust case after a harness refactor ran four sentences again, so that case is the weak spot.

The `opened` gate first failed one skill-on page that had been opened as `…-project//2026-…html`.
The file was right and the comparison was naive. The harness now normalises the path, and all
three runs were re-scored after that fix.

The candidate's `options_verbatim` failure (`wrong-pick-bash-pipefail` trial 0) is real:
the page wrote "A. …" inside each `<li>`, and `ol.options` already adds the letter, so the
reader sees it twice. It happened once in 60 trials, in the candidate run. Nothing in the
change asks for it, so it is most likely noise, but it is a gate that can fail.

## What this shows and what it does not

- **The page contract holds.** Template intact, sections in order, options verbatim with the
  pick and the right one marked, a captioned SVG with the template's classes, the attempt
  linked, role tokens, no emoji, one file, opened, a one-line reply: 59 of 60 pages across both
  runs. That includes the case where `eklavya` resolves only from the runtime `.bin`.
- **The short answer improved, and that result is strong.** 14/30 to 28/29 on the judge, and
  17 to 3 on a count that needs no judge.
- **Whole-page understanding did not measurably improve.** 17–13 pairwise is what chance gives
  about 58% of the time (two-sided binomial). The clarity score is near its ceiling in both
  runs, so it cannot separate them.
- **Pages got longer.** They grew by 17%, because the detail the short answer gave up moved
  into the body. The judge did not penalise that, and the pairwise judge was told to prefer a
  shorter page that lands the idea. Whether readers mind is not measured here.
- The judge and the agent are one model family, so it may be grading its own style. Ten cases
  are a sample, with no Java, C# or Kotlin case. The skill-on run is one trial per case.
- **Installed users get the change too.** The artifact skill wins over the agent file when
  present, but it sets no rule for the short answer, so the new rule still applies. With the
  skill on, 1 of 10 short answers ran past three sentences.

## What would disprove this

A baseline run with the skill on in which short answers are already brief: that would make
the agent-file change irrelevant for installed users. It was not run. Or a second candidate
run in which `short_answer_brief` fails as often as the baseline's 17.
