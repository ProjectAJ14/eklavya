---
name: pack
description: Write or edit an Eklavya concept pack — a JSON file of concepts, tiers and prerequisites that adds a domain, or a team's own codebase, to what Eklavya can quiz on.
disable-model-invocation: true
---

# /eklavya:pack [domain or repo]

Eklavya ships four graphs — git, node-backend, react, web-auth. A **pack** is the same file shape, written by someone else, merged over the shipped ones. It is how Rust or Kubernetes gets added without a pull request to Eklavya, and how a team teaches its own codebase.

Two places, and the difference is the whole decision:

| Where | Who it is for |
|---|---|
| `~/.eklavya/packs/*.json` | this developer, on every project |
| `<repo>/.eklavya/packs/*.json` | everyone who works in this repository, versioned with it |

The repo one is the interesting half. A codebase that ships its own concepts and prerequisites is describing itself to whoever joins next, and that is onboarding rather than quizzing. Ask which one they want before writing anything, and say what the repo scope means: it is committed, and it applies to every contributor.

## Build the pack in this order

1. **Read before you write.** `get_concept_graph` for the domain they named. If Eklavya already seeds it, the pack is an *extension* — new concepts, retiered old ones — not a replacement.
2. **Name it.** `pack` is an identifier (`eklavya-pack-rust`, `acme-billing`), `version` is a string you bump when you edit it, `domain` is the one word that groups these concepts in a learner profile.
3. **List the concepts, from the code.** For a repo pack, read the codebase: the modules, the invariants, the decisions someone new gets wrong. Each concept is `{ slug, name, tier, description }`. A slug is lowercase, hyphenated, and names the *idea* — `event-sourcing-replay`, not `fixed-the-replay-bug`.
4. **Set each tier honestly.** 1 is what a thing is; 3 is why this choice here; 5 is when the architecture is wrong. A pack where everything is tier 3 teaches nothing about order.
5. **Add the prerequisites.** `{ from, to, relation }`, relation one of `prerequisite_of`, `related_to`, `part_of`. An edge may point at a concept Eklavya already seeds — that is how a pack hangs itself off the shipped graph. `from` is the thing that comes first.
6. **Write the file** into the directory the scope chose, and run `eklavya doctor`. It names every pack that loaded and every one that did not, with the reason.

```json
{
  "pack": "acme-billing",
  "version": "1.0.0",
  "domain": "acme",
  "concepts": [
    { "slug": "idempotency-keys", "name": "Idempotency keys", "tier": 2,
      "description": "Why every write endpoint in billing/ takes one, and what a retry does without it." },
    { "slug": "ledger-append-only", "name": "The ledger is append-only", "tier": 3,
      "description": "Corrections are new rows. Nothing in billing/ledger updates a posted entry." }
  ],
  "edges": [
    { "from": "idempotency-keys", "to": "ledger-append-only", "relation": "prerequisite_of" }
  ]
}
```

## What a finished pack has

- Every slug lowercase and hyphenated, every tier between 1 and 5, no slug twice.
- A description on every concept that says something a question could be written from. `"Ownership"` is a name, not a description.
- Between about 10 and 40 concepts. A pack of 200 is a syllabus nobody reaches the end of, and Eklavya asks about what the session touched, not about the list.
- Concepts that are about the domain or the codebase, not about the tools. `webpack-config-splitting` is a concept; `we-use-webpack` is a fact.

## Two things to say, and mean

**A pack merges over the seed; it does not replace it.** Writing `jwt-structure` into a pack retiers the shipped concept rather than adding a second one. That is deliberate — it is how a team says "this is harder here" — but check `get_concept_graph` first, and say it out loud when a repo pack does it: there is one database and no repository column, so the override follows the developer into every other project and does not come back when they leave this one. New slugs are theirs alone; overriding a shipped one is the part worth a sentence before it is committed.

**Removing a pack leaves its concepts behind.** They are what a learner's answers point at, so deleting them would delete the history with them. Uninstalling a pack stops it being re-applied; it does not undo it.

## Then stop

Report what was written, where, and what `eklavya doctor` said about it. Do not quiz on the new concepts — nothing has been logged, and `/eklavya:learn <domain>` is how someone asks to be taught them.
