#!/usr/bin/env python3
"""
Eval and GEPA search for the tutor's concept-logging guidance (issue #175).

    python eval/gepa/extraction/run.py evaluate --out r.json                  # the shipped guidance
    python eval/gepa/extraction/run.py evaluate --prompt cand.md --out c.json # a candidate
    python eval/gepa/extraction/run.py optimize --out runs/ex-search          # GEPA search
    python eval/gepa/extraction/run.py report r.json c.json                   # compare two evaluations

The editable text is the `log_session_concepts` block of `skills/tutor/SKILL.md`
(from "Call `log_session_concepts` as you implement" to the next heading). The
rest of the skill, the tool descriptions, the diffs and the learner profile are
the fixed frame. GEPA never edits the repository: `best_candidate.md` is written
for a person to review and paste, then re-run `evaluate` on the test split.

A trial is what a session does: the model, with the shipped skill in context
(a `claude -p` call, ~44k input tokens), writes the `log_session_concepts` call
for a diff; the product's own handler answers (`matched`, `created`, `next_action`);
if it created concepts, a second call writes the `upsert_concepts` follow-up the
skill owes. Judges see the diff, the labels and the final list.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import pilot  # noqa: E402  the budget, its caps and the progress file are the question pilot's
from pilot import Budget, BudgetExceeded  # noqa: E402

REPO = HERE.parents[2]
BRIDGE = HERE / "bridge.mjs"
SKILL_FILE = REPO / "skills" / "tutor" / "SKILL.md"
FIXTURES = REPO / "eval" / "fixtures"
START = "Call `log_session_concepts` as you implement"
END = "\n## Which one is asking"
# `packaging.test.ts`: whitespace tokens of the whole file, frontmatter included, under 2000.
WORD_CEILING = 2000

GATES = ("count", "valid_slugs", "context_file", "context_decision", "touched", "not_mastered")
WEIGHTS = {"recall": 0.4, "precision": 0.3, "context": 0.15, "followup": 0.15}


def bridge(cmd: str, payload: dict, kind: str | None = None) -> dict:
    """A bridge command; with `kind`, a judge call that is counted against the budget."""
    if kind:
        pilot.BUDGET.spend(kind)
    res = subprocess.run(["node", str(BRIDGE), cmd], input=json.dumps(payload), capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise RuntimeError(f"bridge {cmd} failed: {res.stderr[:300]}")
    out = json.loads(res.stdout)
    if kind:
        pilot.BUDGET.add_usage(kind, {"usage": out.get("usage"), "total_cost_usd": out.get("cost")})
        if out.get("error") and "did not finish" not in out["error"]:
            pilot.BUDGET.errors[kind] += 1
    return out


# ------------------------------------------------------------------ the candidate --

def skill_parts() -> tuple[str, str, str]:
    """(before, shipped guidance block, after): the block is what a candidate replaces."""
    text = SKILL_FILE.read_text()
    a = text.index(START)
    b = text.index(END, a)
    return text[:a], text[a:b].rstrip("\n"), text[b:]


def load_candidate(path: str | None) -> str:
    return skill_parts()[1] if path is None else Path(path).read_text().strip()


def skill_with(guidance: str) -> str:
    before, _, after = skill_parts()
    return before + guidance.strip() + "\n" + after


def over_budget(guidance: str) -> int:
    """Whitespace tokens the whole skill would have, past the ceiling; 0 when it fits."""
    return max(0, len(skill_with(guidance).strip().split()) - (WORD_CEILING - 1))


def strip_frontmatter(text: str) -> str:
    return re.sub(r"^---\n[\s\S]*?\n---\n", "", text).strip()


# ------------------------------------------------------------------ the fixtures --

def load_fixtures() -> dict[str, dict]:
    rows = {}
    paths = list(FIXTURES.glob("*.json")) + list((FIXTURES / "extraction").glob("*.json"))
    for p in paths:
        if p.name == "splits.json":
            continue
        d = json.loads(p.read_text())
        if isinstance(d, dict) and "concepts" in d and "diff" in d:
            rows[d["id"]] = d
    return rows


def pick(split: str, limit: int | None) -> list[dict]:
    splits = json.loads((FIXTURES / "extraction" / "splits.json").read_text())
    rows = load_fixtures()
    out = [dict(rows[i], split=split) for i in splits[split]]
    return out[:limit] if limit else out


# ------------------------------------------------------------------ generation --

_tools: dict | None = None


def tool_text() -> dict:
    global _tools
    if _tools is None:
        _tools = bridge("tools", {})
    return _tools


def profile_text(ex: dict) -> str:
    m = ex.get("mastered") or []
    if not m:
        return "get_learner_profile: no concepts mastered yet that this work touches."
    return "get_learner_profile: already mastered (never quiz these): " + ", ".join(c["slug"] for c in m)


def log_prompt(guidance: str, ex: dict) -> str:
    return "\n".join([
        "You are the Eklavya tutor, working alongside a developer. Follow the skill below.",
        "",
        "=== SKILL (shipped) ===",
        strip_frontmatter(skill_with(guidance)),
        "",
        "=== TOOLS ===",
        f"log_session_concepts: {tool_text()['log']}",
        "  concepts: [{slug, name? (1-3 words), domain?, tier? (1-5), description? (400 chars), tags? (5), new? (boolean), prerequisites? (slugs, 5), context?}], 1 to 50 entries",
        "",
        "=== THE LEARNER ===",
        profile_text(ex),
        "",
        "=== THE CODE YOU JUST WROTE ===",
        f"File: {ex['source']}",
        "```",
        ex["diff"],
        "```",
        "",
        "Produce the log_session_concepts call you would make for this work.",
        'Reply with a single JSON object and nothing else: {"concepts": [{"slug": "kebab-case", "name": "Short Name", "description": "...", "tags": ["..."], "prerequisites": ["..."], "context": "..."}]}',
    ])


def followup_prompt(guidance: str, ex: dict, first: dict, result: dict) -> str:
    return "\n".join([
        log_prompt(guidance, ex),
        "",
        "=== YOUR CALL ===",
        json.dumps(first),
        "",
        "=== THE TOOL'S RESPONSE ===",
        json.dumps(result),
        "",
        f"upsert_concepts: {tool_text()['upsert']}",
        "  concepts: [{slug, name?, domain?, tier? (1-5), description?}], edges: [{from, to, relation: prerequisite_of|related_to|part_of}]",
        "",
        "Do whatever the skill and the response ask of you next. Reply with a single JSON object and nothing else:",
        '{"concepts": [...], "edges": [...]} for the upsert_concepts call you would make, or {"skip": true} if nothing is owed.',
    ])


def decide_prompt(guidance: str, ex: dict, first: dict, result: dict) -> str:
    """The second round of a session: the tool held lookalikes in `needs_decision` and the model must pick."""
    return "\n".join([
        log_prompt(guidance, ex),
        "",
        "=== YOUR CALL ===",
        json.dumps(first),
        "",
        "=== THE TOOL'S RESPONSE ===",
        json.dumps({k: result[k] for k in ("logged", "created", "matched", "needs_decision", "next_action") if k in result}),
        "",
        "The response asks you to decide. Reply with a single JSON object and nothing else:",
        '{"concepts": [...]} for only the held concepts: a candidate\'s slug when it is the same idea, or the same slug with "new": true when none is.',
    ])


def slug_key(slug: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")


def play(guidance: str, ex: dict, model: str | None, home: str, cmd: str, base: dict, first: dict) -> tuple[dict, list[dict], list[list[dict]]]:
    """Round one, and a second when the tool held concepts for a decision.

    Returns (the bridge's answer to the whole session, the concepts that ended up logged, the rounds played).
    """
    rounds = [first["concepts"]]
    logged = bridge(cmd, {**base, "home": home, "rounds": rounds})
    final = list(first["concepts"])
    held = [] if logged.get("error") else logged["result"].get("needs_decision") or []
    if held:
        raw = pilot.claude(decide_prompt(guidance, ex, first, logged["result"]), "generate", model)
        second = last_json(raw, "concepts")
        if second and isinstance(second.get("concepts"), list) and second["concepts"]:
            names = {slug_key(h["requested"]) for h in held}
            final = [c for c in first["concepts"] if slug_key(c["slug"]) not in names] + second["concepts"]
            rounds = [first["concepts"], second["concepts"]]
            logged = bridge(cmd, {**base, "home": home, "rounds": rounds})
        else:
            names = {slug_key(h["requested"]) for h in held}
            final = [c for c in first["concepts"] if slug_key(c["slug"]) not in names]
    return logged, final, rounds


def last_json(text: str, key: str) -> dict | None:
    """The last JSON object in a reply that has `key` (a model may wrap it in prose or a fence)."""
    dec, best = json.JSONDecoder(), None
    for m in re.finditer(r"\{", text):
        try:
            obj, _ = dec.raw_decode(text[m.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and (key in obj or "skip" in obj):
            best = obj
    return best


# ------------------------------------------------------------------ scoring --

def score(det: dict, judged: dict, log_hit: list[str], followup: dict) -> tuple[float, dict]:
    """Gates first, as the question pilot and feedback eval do: a failure caps the score at 0.5."""
    ok = "error" not in judged
    v = judged.get("verdicts", {})
    gate = {
        "count": bool(det["count_ok"]),
        "valid_slugs": bool(det["slugs_valid"]),
        "context_file": bool(det["context_file"]),
        "context_decision": ok and bool(v) and all(x["context_level"] == 2 for x in v.values()),
        "touched": ok and bool(v) and all(x["touched"] for x in v.values()),
        "not_mastered": not log_hit,
    }
    n = len(v) or 1
    owed = followup.get("owed", [])
    quality = {
        "recall": statistics.fmean(judged["coverage"].values()) if ok and judged.get("coverage") else 0.0,
        "precision": sum(1 for x in v.values() if x["exercised"]) / n if ok else 0.0,
        "context": det["context_grounded"],
        "followup": statistics.fmean(1.0 if (o["domain"] and o["tier"] and o["edge"]) else 0.0 for o in owed) if owed else 1.0,
    }
    q = sum(quality[k] * w for k, w in WEIGHTS.items())
    failed = [g for g, passed in gate.items() if not passed]
    fraction = (len(gate) - len(failed)) / len(gate)
    total = round(0.5 * fraction * (0.8 + 0.2 * q) if failed else 0.5 + 0.5 * q, 4)
    return total, {"score": total, "gates_failed": failed, "quality": quality}


def run_example(guidance: str, ex: dict, model: str, judges: list[str]) -> tuple[float, dict]:
    if over_budget(guidance):
        return 0.0, {"score": 0.0, "gates_failed": ["word_ceiling"], "error": f"skill would pass the {WORD_CEILING}-token ceiling by {over_budget(guidance)}"}
    home = tempfile.mkdtemp(prefix="eklavya-extract-eval-")
    fx = {k: ex[k] for k in ("id", "source", "diff", "concepts", "mastered") if k in ex}
    try:
        raw = pilot.claude(log_prompt(guidance, ex), "generate", model)
        first = last_json(raw, "concepts")
        if not first or not isinstance(first.get("concepts"), list) or not first["concepts"]:
            return 0.0, {"score": 0.0, "gates_failed": ["generation"], "error": "no parsable concepts in the reply", "reply": raw[:300]}
        logged, concepts, rounds = play(guidance, ex, model, home, "log", {"fixture": fx}, first)
        if logged.get("error"):
            return 0.0, {"score": 0.0, "gates_failed": ["valid_slugs"], "error": f"tool rejected the call: {logged['error']}", "concepts": concepts}
        result = logged["result"]

        followup: dict = {"owed": []}
        # Only the created concepts the log call left without an edge owe a follow-up.
        if result.get("unlinked"):
            raw2 = pilot.claude(followup_prompt(guidance, ex, first, result), "generate", model)
            second = last_json(raw2, "concepts") or {"skip": True}
            if second.get("skip"):
                second = {}
            args = {k: second[k] for k in ("concepts", "edges") if k in second}
            followup = bridge("followup", {"home": home, "fixture": fx, "rounds": rounds, "created": result["unlinked"], "args": args})
            followup["skipped"] = not args.get("concepts")

        det = bridge("score", {"fixture": fx, "concepts": concepts})
        kept = result["logged"]  # canonical slugs the product settled on, in order
        judged = judge(fx, concepts, judges)
        total, info = score(det, judged, logged["mastered_hit"], followup)
        info.update(det=det, judged=judged, concepts=concepts, matched=result["matched"], created=result["created"], logged=kept,
                    mastered_hit=logged["mastered_hit"], followup=followup)
        return total, info
    finally:
        shutil.rmtree(home, ignore_errors=True)


def judge(fx: dict, concepts: list[dict], judges: list[str]) -> dict:
    """Exercised/touched/context from the first judge; coverage from every judge, so their disagreement is visible."""
    out: dict = {}
    ex = bridge("judge-exercised", {"model": judges[0], "fixture": fx, "concepts": concepts}, "judge")
    if ex.get("error"):
        return {"error": ex["error"]}
    by = {v["slug"]: v for v in ex["verdicts"]}
    missing = [c["slug"] for c in concepts if c["slug"] not in by]
    if missing:
        return {"error": f"judge skipped {len(missing)} concept(s)"}
    out["verdicts"] = {c["slug"]: by[c["slug"]] for c in concepts}
    out["coverage"], out["covered"] = {}, {}
    labels = [c["slug"] for c in fx["concepts"]]
    for m in judges:
        cv = bridge("judge-coverage", {"model": m, "fixture": fx, "concepts": concepts}, "judge")
        if cv.get("error"):
            return {"error": cv["error"]}
        out["covered"][m] = cv["covered"]
        out["coverage"][m] = len(cv["covered"]) / len(labels) if labels else 1.0
    return out


# ------------------------------------------------------------------ reports --

def summarise(trials: list[dict]) -> dict:
    ok = [t for t in trials if not t.get("gates_failed")]
    judged = [t for t in trials if t.get("quality")]
    mean = lambda k: round(statistics.fmean(t["quality"][k] for t in judged), 3) if judged else None
    models = sorted({m for t in judged for m in t.get("judged", {}).get("coverage", {})})
    per_judge = {m: round(statistics.fmean(t["judged"]["coverage"][m] for t in judged if m in t["judged"].get("coverage", {})), 3) for m in models}
    # The strict slug number is published beside the judged one as a record of what it does not measure.
    strict = [t["det"]["strict"] for t in judged if t.get("det")]
    agree = [len(set(t["judged"]["covered"][models[0]]) & set(t["judged"]["covered"][models[-1]])) for t in judged if len(models) > 1 and t["judged"].get("covered")]
    union = [len(set(t["judged"]["covered"][models[0]]) | set(t["judged"]["covered"][models[-1]])) for t in judged if len(models) > 1 and t["judged"].get("covered")]
    return {
        "trials": len(trials),
        "all_gates_passed": len(ok),
        "gate_failures": dict(Counter(g for t in trials for g in t.get("gates_failed", []))),
        "mean_score": round(statistics.fmean(t["score"] for t in trials), 4) if trials else None,
        "quality_means": {k: mean(k) for k in WEIGHTS},
        "recall_by_judge": per_judge,
        "judge_agreement_on_covered": round(sum(agree) / sum(union), 3) if sum(union) else None,
        "strict_slug_recall": round(statistics.fmean(s["recall"] for s in strict), 3) if strict else None,
        "strict_slug_precision": round(statistics.fmean(s["precision"] for s in strict), 3) if strict else None,
        "mastered_logged": sum(1 for t in trials if t.get("mastered_hit")),
        "concepts_created": sum(len(t.get("created", [])) for t in trials),
        "followups_skipped": sum(1 for t in trials if t.get("followup", {}).get("skipped")),
        "db_applied_domain": _applied(trials),
    }


def _applied(trials: list[dict]) -> dict:
    """upsert_concepts leaves an existing concept's domain and tier alone; this counts the owed slugs where the database kept 'general'."""
    owed = [o for t in trials for o in t.get("followup", {}).get("owed", []) if o["domain"]]
    return {"asked_for_a_domain": len(owed), "stored_as_general": sum(1 for o in owed if o["stored_domain"] == "general")}


def cmd_evaluate(args) -> None:
    pilot.BUDGET = Budget(args.max_model_calls, args.max_minutes)
    guidance = load_candidate(args.prompt)
    judges = [args.judge_model, args.second_judge]
    rows = pick(args.split, args.limit)
    jobs = [(ex, r) for ex in rows for r in range(args.repeats)]
    pilot.BUDGET.track(Path(args.out).with_suffix(".progress.json"), f"extraction evaluate {Path(args.prompt or 'shipped').name} ({args.split})", len(jobs))
    trials, stopped = [], None

    def one(job):
        ex, r = job
        total, info = run_example(guidance, ex, args.model, judges)
        row = {"id": ex["id"], "repeat": r, **info}
        with pilot.BUDGET._lock:
            pilot.BUDGET.done += 1
            pilot.BUDGET.trials.append(row)
        pilot.BUDGET.flush(force=True)
        return row

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for f in [pool.submit(one, j) for j in jobs]:
            try:
                trials.append(f.result())
            except BudgetExceeded as err:
                stopped = str(err)
    result = {"prompt": args.prompt or "shipped guidance", "model": args.model or "default", "judges": judges, "split": args.split, "repeats": args.repeats, "trials": trials, "stopped_early": stopped, "budget": pilot.BUDGET.summary(), "summary": summarise(trials)}
    Path(args.out).write_text(json.dumps(result, indent=1))
    pilot.BUDGET.state = "stopped early" if stopped else "done"
    pilot.BUDGET.flush(force=True)
    print(json.dumps({"summary": result["summary"], "budget": result["budget"], "stopped_early": stopped}, indent=1))


def cmd_report(args) -> None:
    base, cand = (json.loads(Path(p).read_text()) for p in (args.baseline, args.candidate))

    def by_id(r):
        d: dict[str, list[float]] = {}
        for t in r["trials"]:
            d.setdefault(t["id"], []).append(t["score"])
        return {k: statistics.fmean(v) for k, v in d.items()}

    b, c = by_id(base), by_id(cand)
    shared = sorted(set(b) & set(c))
    wins = sum(c[k] > b[k] + 1e-9 for k in shared)
    losses = sum(c[k] < b[k] - 1e-9 for k in shared)
    print(f"fixtures compared: {len(shared)}  candidate wins {wins}, losses {losses}, ties {len(shared) - wins - losses}")
    for k in shared:
        print(f"  {k}: {b[k]:.3f} -> {c[k]:.3f}")
    for name, r in (("baseline", base), ("candidate", cand)):
        s, tk = r["summary"], r["budget"]["tokens"]
        print(f"\n{name}: {r['prompt']}")
        print(f"  {s['all_gates_passed']}/{s['trials']} pass every gate, mean score {s['mean_score']}")
        print(f"  gate failures: {s['gate_failures']}")
        print(f"  quality means: {s['quality_means']}")
        print(f"  recall by judge: {s['recall_by_judge']} (agree on {s['judge_agreement_on_covered']} of covered); strict slug recall {s['strict_slug_recall']}, precision {s['strict_slug_precision']}")
        print(f"  created {s['concepts_created']}, follow-ups skipped {s['followups_skipped']}, mastered logged {s['mastered_logged']}; domain asked for vs stored: {s['db_applied_domain']}")
        print(f"  calls {r['budget']['calls']}; tokens {tk['input_total']:,} in ({tk['cache_read']:,} cached) + {tk['output']:,} out, ~${r['budget']['cost_usd_list_price']} at list price; stopped early: {r['stopped_early']}")


def cmd_optimize(args) -> None:
    import gepa.optimize_anything as oa  # imported late so `evaluate` and `report` need no GEPA install
    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    pilot.BUDGET = Budget(args.max_model_calls, args.max_minutes)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    seed = load_candidate(args.prompt)
    (out / "seed.md").write_text(seed + "\n")
    train, val = pick("train", None), pick("val", None)
    judges = [args.judge_model, args.second_judge]
    pilot.BUDGET.track(out / "progress.json", f"extraction optimize ({args.metric_calls} metric calls)", args.metric_calls)

    def evaluator(candidate: str, example: dict):
        total, info = run_example(candidate, example, args.model, judges)
        with pilot.BUDGET._lock:
            pilot.BUDGET.done += 1
            pilot.BUDGET.trials.append({"id": example["id"], "candidate": hashlib.sha1(candidate.encode()).hexdigest()[:8], **info})
        pilot.BUDGET.flush(force=True)
        # GEPA's reflection reads this: what was wrong, in words, per example.
        judged = info.get("judged", {})
        oa.log(json.dumps({
            "fixture": example["id"], "gates_failed": info.get("gates_failed"), "error": info.get("error"), "quality": info.get("quality"),
            "logged": [{"slug": c.get("slug"), "context": c.get("context")} for c in info.get("concepts", [])],
            "labelled_not_covered": [s for s in (c["slug"] for c in example["concepts"]) if not any(s in cov for cov in judged.get("covered", {}).values())],
            "mastered_logged": info.get("mastered_hit"),
            "not_touched_or_vague": {k: {"touched": v["touched"], "context_level": v["context_level"], "why": v["why"]} for k, v in judged.get("verdicts", {}).items() if not v["touched"] or v["context_level"] < 2},
            "followup": info.get("followup", {}).get("owed"),
        }))
        return total, info

    def reflection_lm(prompt) -> str:
        got = bridge("reflect", {"model": args.reflect_model, "prompt": prompt if isinstance(prompt, str) else json.dumps(prompt)}, "reflect")
        if got.get("error"):
            raise RuntimeError(got["error"])
        return "```\n" + got["text"] + "\n```"  # GEPA takes the new candidate from a fenced block

    config = GEPAConfig(
        engine=EngineConfig(run_dir=str(out / "gepa-state"), seed=args.seed, max_metric_calls=args.metric_calls, max_workers=args.workers, raise_on_exception=False, display_progress_bar=False),
        reflection=ReflectionConfig(reflection_lm=reflection_lm, reflection_minibatch_size=args.minibatch),
    )
    stopped, result = None, None
    try:
        result = optimize_anything(
            seed_candidate=seed,
            evaluator=evaluator,
            dataset=train,
            valset=val,
            objective=(
                "Rewrite the concept-logging guidance of the Eklavya tutor skill so that, given a code change, the agent logs 3 to 8 concepts the change genuinely exercises "
                "(the ones a developer would learn something from), each with a context naming the file and the decision made there, and then does the follow-up the tool response asks for."
            ),
            background=(
                "Hard rules a rewrite must keep: it replaces one block of a skill file that must stay under a fixed word ceiling, so it may not be longer than the shipped block by more than a few words "
                "(a candidate over the ceiling scores 0); 3-8 concepts per batch; `context` names the actual decision in the actual file (good: \"set httpOnly on the refresh cookie in auth.ts:42\", useless: \"used cookies\"); "
                "a concept is a topic named in 1-3 words with a `description` and `tags`; an unknown slug that resembles existing concepts comes back in `needs_decision` and is answered with a candidate's slug or `new: true`; give each concept an honest `tier` and `prerequisites`, and a `created` slug still `unlinked` owes an `upsert_concepts` edge; "
                "never log a concept the learner's profile says is mastered; logging is silent: never narrate it or pause the work. "
                "Do not add per-example special cases or concept lists."
            ),
            config=config,
        )
    except BudgetExceeded as err:
        stopped = str(err)
    pilot.BUDGET.state = "stopped early" if stopped else "done"
    pilot.BUDGET.flush(force=True)
    best = result.best_candidate if result else seed
    best = best if isinstance(best, str) else next(iter(best.values()))
    (out / "best_candidate.md").write_text(best.strip() + "\n")
    (out / "summary.json").write_text(json.dumps({"metric_calls": args.metric_calls, "train": len(train), "val": len(val), "seed": args.seed, "model": args.model or "default", "judges": judges, "reflect_model": args.reflect_model, "stopped_early": stopped, "words_over_ceiling": over_budget(best), "budget": pilot.BUDGET.summary()}, indent=1))
    print(f"wrote {out}/best_candidate.md; budget {pilot.BUDGET.summary()}; stopped early: {stopped}; words over the ceiling: {over_budget(best)}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--max-model-calls", type=int, default=120, help="hard cap over generation, judging and reflection")
    common.add_argument("--max-minutes", type=float, default=60)
    common.add_argument("--workers", type=int, default=3)
    common.add_argument("--prompt", default=None, help="a replacement for the guidance block (.md); default: the shipped block")
    common.add_argument("--model", default=None, help="the generating model, as `claude -p --model`; default: Claude Code's own")
    common.add_argument("--judge-model", default="sonnet", help="exercised/touched/context judge, and the first coverage judge")
    common.add_argument("--second-judge", default="claude-haiku-4-5", help="the second coverage judge: a different model, since generator and judge were one family in the September run")
    o = sub.add_parser("optimize", parents=[common])
    o.add_argument("--out", required=True)
    o.add_argument("--metric-calls", type=int, default=60)
    o.add_argument("--minibatch", type=int, default=3)
    o.add_argument("--seed", type=int, default=0)
    o.add_argument("--reflect-model", default="sonnet")
    e = sub.add_parser("evaluate", parents=[common])
    e.add_argument("--split", choices=("train", "val", "test"), default="test")
    e.add_argument("--limit", type=int, default=None)
    e.add_argument("--repeats", type=int, default=3)
    e.add_argument("--out", required=True)
    r = sub.add_parser("report")
    r.add_argument("baseline")
    r.add_argument("candidate")
    args = p.parse_args()
    {"optimize": cmd_optimize, "evaluate": cmd_evaluate, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
