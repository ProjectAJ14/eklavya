#!/usr/bin/env python3
"""
Concept dedup and shape eval: does a session reuse a concept the learner's graph already has,
or mint a near-duplicate, and are the concepts it mints short, described and tagged?

    python3 eval/gepa/dedup/run.py evaluate --split test --limit 2 --repeats 1 --out r.json
    python3 eval/gepa/dedup/run.py report before.json after.json

Manual only. A trial is one `claude -p` call (~44k input tokens) with the shipped tutor skill in
context. No judges: the checks are deterministic, against `eval/fixtures/dedup/scenarios.json`.
Same seam as the extraction eval: the product's own `log_session_concepts` handler answers
against a real database in a temp EKLAVYA_HOME seeded with the scenario's existing concepts.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import statistics
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import pilot  # noqa: E402
from pilot import Budget, BudgetExceeded  # noqa: E402

# The extraction runner owns the prompt, bridge and skill plumbing; reuse it rather than restate it.
_spec = importlib.util.spec_from_file_location("extraction_run", HERE.parent / "extraction" / "run.py")
ex = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ex)

SCENARIOS = ex.REPO / "eval" / "fixtures" / "dedup" / "scenarios.json"
MAX_NAME_WORDS = 3
WEIGHTS = {"resolved": 0.5, "no_duplicate": 0.3, "short_name": 0.2}


def prompt(guidance: str, sc: dict) -> str:
    return ex.log_prompt(guidance, scenario_ex(sc))


def scenario_ex(sc: dict) -> dict:
    return {"source": sc["source"], "diff": sc["diff"], "mastered": []}


def words(s: str) -> int:
    return len([w for w in s.replace("-", " ").split() if w])


def score(sc: dict, result: dict, stored: list[dict]) -> tuple[float, dict]:
    want = sc["expect"]
    logged, created = result["logged"], result["created"]
    resolved = all(s in logged for s in want["reuse"]) if want["reuse"] else bool(created)
    dups = [s for s in created if any(t in s for t in want["dup_tokens"])] if want["reuse"] else []
    longest = [c["name"] for c in stored if words(c["name"]) > MAX_NAME_WORDS]
    short = 1.0 - len(longest) / len(stored) if stored else 1.0
    quality = {"resolved": float(resolved), "no_duplicate": float(not dups), "short_name": round(short, 3)}
    total = round(sum(quality[k] * w for k, w in WEIGHTS.items()), 4)
    return total, {
        "score": total, "quality": quality,
        "resolved_to_existing": [s for s in want["reuse"] if s in logged], "duplicates_created": dups, "long_names": longest,
        # What a created concept carries. Today the call has no place for a description or tags.
        "created_with_description": sum(1 for c in stored if c.get("description")),
        "created_with_tags": sum(1 for c in stored if c.get("tags") not in (None, "", "[]")),
        "created": created, "matched": result["matched"], "logged": logged,
    }


def run_one(guidance: str, sc: dict, model: str | None) -> tuple[float, dict]:
    home = tempfile.mkdtemp(prefix="eklavya-dedup-eval-")
    try:
        raw = pilot.claude(prompt(guidance, sc), "generate", model)
        first = ex.last_json(raw, "concepts")
        if not first or not isinstance(first.get("concepts"), list) or not first["concepts"]:
            return 0.0, {"score": 0.0, "gates_failed": ["generation"], "error": "no parsable concepts", "reply": raw[:300]}
        out, final, _ = ex.play(guidance, scenario_ex(sc), model, home, "dedup-log", {"existing": sc["existing"]}, first)
        if out.get("error"):
            return 0.0, {"score": 0.0, "gates_failed": ["valid_call"], "error": out["error"], "concepts": first["concepts"]}
        total, info = score(sc, out["result"], out["stored"])
        info["concepts"] = final
        info["undecided"] = [h["requested"] for h in out["result"].get("needs_decision") or []]
        return total, info
    finally:
        shutil.rmtree(home, ignore_errors=True)


def pick(split: str, limit: int | None) -> list[dict]:
    rows = [s for s in json.loads(SCENARIOS.read_text())["scenarios"] if s["split"] == split]
    return rows[:limit] if limit else rows


def summarise(trials: list[dict]) -> dict:
    ok = [t for t in trials if "quality" in t]
    mean = lambda k: round(statistics.fmean(t["quality"][k] for t in ok), 3) if ok else None
    created = sum(len(t["created"]) for t in ok)
    return {
        "trials": len(trials), "scored": len(ok),
        "mean_score": round(statistics.fmean(t["score"] for t in trials), 4) if trials else None,
        "resolved_to_existing_or_new": mean("resolved"), "no_duplicate_minted": mean("no_duplicate"), "short_names": mean("short_name"),
        "duplicates_created": sum(len(t["duplicates_created"]) for t in ok),
        "concepts_created": created,
        "created_with_description": sum(t["created_with_description"] for t in ok),
        "created_with_tags": sum(t["created_with_tags"] for t in ok),
        "failed": [t["id"] for t in trials if t.get("gates_failed")],
    }


def cmd_evaluate(args) -> None:
    pilot.BUDGET = Budget(args.max_model_calls, args.max_minutes)
    guidance = ex.load_candidate(args.prompt)
    rows = pick(args.split, args.limit)
    jobs = [(sc, r) for sc in rows for r in range(args.repeats)]
    pilot.BUDGET.track(Path(args.out).with_suffix(".progress.json"), f"dedup evaluate ({args.split})", len(jobs))
    trials, stopped = [], None

    def one(job):
        sc, r = job
        total, info = run_one(guidance, sc, args.model)
        row = {"id": sc["id"], "repeat": r, **info}
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
            except Exception as err:  # one failed call must not discard the finished trials
                print(f"trial failed: {err}", file=sys.stderr)
    result = {"prompt": args.prompt or "shipped guidance", "model": args.model or "default", "split": args.split, "repeats": args.repeats,
              "trials": trials, "stopped_early": stopped, "budget": pilot.BUDGET.summary(), "summary": summarise(trials)}
    Path(args.out).write_text(json.dumps(result, indent=1))
    pilot.BUDGET.state = "stopped early" if stopped else "done"
    pilot.BUDGET.flush(force=True)
    print(json.dumps({"summary": result["summary"], "budget": result["budget"], "stopped_early": stopped}, indent=1))


def cmd_report(args) -> None:
    a, b = (json.loads(Path(p).read_text())["summary"] for p in (args.before, args.after))
    for k in a:
        if k != "failed":
            print(f"{k:32} {a[k]!s:>8} -> {b[k]!s:>8}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("evaluate")
    e.add_argument("--split", choices=("train", "val", "test"), default="test")
    e.add_argument("--limit", type=int, default=None)
    e.add_argument("--repeats", type=int, default=3)
    e.add_argument("--workers", type=int, default=3)
    e.add_argument("--max-model-calls", type=int, default=40, help="hard cap; one call per trial")
    e.add_argument("--max-minutes", type=float, default=30)
    e.add_argument("--prompt", default=None, help="a replacement for the guidance block (.md); default: the shipped block")
    e.add_argument("--model", default=None)
    e.add_argument("--out", required=True)
    r = sub.add_parser("report")
    r.add_argument("before")
    r.add_argument("after")
    args = p.parse_args()
    {"evaluate": cmd_evaluate, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
