# Handoff: textstats 0.2, four stages

textstats prints word, line and character counts. This release fixes how words
are counted and adds frequent-word reports, a real argument parser and an HTML
report. Implement the stages in order: each stage builds on the previous one.

Every stage ends with `npm run lint` and `npm test` passing and its own commit.
Commit subjects are conventional commits ending with the stage tag, for example
`fix(stats): count only real words [stage 1]`. No new dependencies.

## Stage 1 — fix: word counting is wrong on real text

Defects, each needing a failing test before the fix:

- `wordCount('')` returns 1, and leading or trailing whitespace counts as an extra
  word (`wordCount('  hi ')` returns 3). Expected 0 and 1.
- Punctuation-only tokens count as words: `wordCount('a - b')` returns 3, expected 2.
- Contractions and hyphenated words must stay one word (`don't`,
  `state-of-the-art`); numbers (`42`, `3.14`) are not words.

Move tokenization into a new `src/tokenize.js` (`tokenize(text) -> string[]`,
lower-cased words, surrounding punctuation stripped) and use it from
`src/stats.js`. Test `tokenize` directly.

## Stage 2 — feat: most frequent words with stop words

Add `topWords(text, { n, minLength = 1, stopwords = DEFAULT_STOPWORDS })` to
`src/stats.js`, returning up to `n` entries `{ word, count }` sorted by count
descending, then alphabetically. Put `DEFAULT_STOPWORDS` (at least: a, an, and,
the, of, to, in, is, it) and `loadStopwords(file)` in a new `src/stopwords.js`.
A stop-word file has one word per line; blank lines and lines starting with `#`
are ignored. A missing file throws an error naming the path.

Tests: ties, case folding, `minLength`, default stop words, a custom file, and the
missing-file error.

## Stage 3 — feat: argument parser and new CLI options

Replace `process.argv[2]` with a parser in a new `src/args.js` (no
dependencies). Options:

| Option | Meaning |
|---|---|
| `--top N` | also print the N most frequent words, one `top: <word> <count>` line each |
| `--min-length N` | ignore words shorter than N in `--top` |
| `--stopwords FILE` | use this stop-word file instead of the defaults |
| `--json` | print `{ words, lines, chars, top? }` as JSON instead of text |
| `--help` | print usage and exit 0 |

Several input files are summed; `-` reads stdin. A bad option, a missing value,
a non-numeric `N` or an unreadable file prints one line to stderr and exits 2.
Put text formatting in `src/format.js`. Test the parser directly, and the CLI by
spawning it for every option and every error.

## Stage 4 — feat: HTML report

`--html OUT` writes a standalone HTML file (no external assets): a summary table
of the counts and, when `--top` is given, a table of the top words with an inline
SVG bar per word, scaled to the most frequent. Every piece of input text is
HTML-escaped (test it with a `<script>` word). The output is deterministic: no
timestamps or random ids. Put it in a new `src/html.js`, test the generated
markup, and document every option in a usage section in `README.md`.
