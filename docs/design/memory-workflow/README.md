# Memory workflow redesign (design proposal)

A proposal for reshaping the dashboard's Memory workflow around what memory
gives the developer, instead of how its pipeline works. Nothing here is
implemented; it is a design record, not documentation of shipped behavior.

## Proposal

The five Memory pages (Timeline, Sessions, Projects, Reuse, Health) become
three:

| Page | What it gives the developer |
|---|---|
| Overview | An ask box, where you left off, the exact entries the next session will start with (removable), and decisions waiting. Pipeline counts collapse to one line. |
| Library | One list, grouped by entries, sessions or projects. Keep, correct, delete and "include in next session" happen on the entry. |
| Impact | Reuse savings and capture health, read together. Not drawn yet. |

## Files

| File | Shows |
|---|---|
| `overview.dc.html` | The Overview page, with the Archer Cloak mascot |
| `library.dc.html` | The Library page (interactive: grouping toggle, entry panel) |
| `model.dc.html` | Today's pages against the proposed ones, and what each gives the user |

They are Design Component artboards, authored for a design canvas, and need its
`support.js` runtime to render; they are not standalone pages. All numbers and
entries are sample data.

## Not verified against the code

Grounded in the code: the next-session list (retrieval limits and the recall
renderer in `mcp/src/memory/recall.ts`, `retrieval.max_items` and
`retrieval.max_tokens` in `mcp/src/config.ts`).

Not checked, and likely needing new backend work: the ask box with answers,
"where you left off", "copy as prompt", draft observations as a review queue,
and contradiction detection.
