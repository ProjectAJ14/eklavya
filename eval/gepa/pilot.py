#!/usr/bin/env python3
"""
Offline GEPA pilot for the tutor's question-writing instructions (issue #156).

    python eval/gepa/pilot.py optimize --out /tmp/gepa-run            # search
    python eval/gepa/pilot.py evaluate --prompt <file> --out r.json   # score a prompt on a split
    python eval/gepa/pilot.py report   base.json cand.json            # compare two evaluations

What it edits: only the text of `skills/tutor/references/writing-mcq.md`. The
planner's output, the rest of the tutor skill, grading, answer placement and
learner preferences are a fixed frame around it. Nothing here writes to the
repository's prompts, to configuration or to a learner database; the selected
candidate is written under `--out` for a person to review as a diff.

Every model call goes through `claude -p` on the machine's own subscription:
the generator, the two judges and GEPA's reflection model. The question checks
and judge wording are the repository's own (`bridge.mjs`), not ports.

Budgets are hard. `--max-model-calls` and `--max-minutes` stop the run when
reached, counted across generation, judging and reflection, because GEPA's own
metric-call limit counts neither the judges nor the reflection model.
"""
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRIDGE = HERE / "bridge.mjs"
SEED_FILE = REPO / "skills" / "tutor" / "references" / "writing-mcq.md"
SKILL_FILE = REPO / "skills" / "tutor" / "SKILL.md"


class BudgetExceeded(RuntimeError):
    pass


class Budget:
    """Counts every model call and the clock; raises once either cap is passed."""

    def __init__(self, max_calls: int, max_minutes: float, max_errors: int = 12):
        self.max_errors = max_errors
        self.max_calls, self.deadline = max_calls, time.time() + max_minutes * 60
        self.calls: Counter[str] = Counter()
        self.seconds: Counter[str] = Counter()
        self.errors: Counter[str] = Counter()
        self._lock = threading.Lock()

    def spend(self, kind: str) -> None:
        with self._lock:
            if sum(self.calls.values()) >= self.max_calls:
                raise BudgetExceeded(f"model-call cap {self.max_calls} reached")
            if time.time() > self.deadline:
                raise BudgetExceeded("time cap reached")
            # A run whose calls keep failing (a usage limit, a network outage) is
            # not measuring the prompt: stop instead of scoring failures as results.
            if sum(self.errors.values()) >= self.max_errors:
                raise BudgetExceeded(f"{self.max_errors} model calls failed; results would not be valid")
            self.calls[kind] += 1

    def summary(self) -> dict:
        return {"calls": dict(self.calls), "total_calls": sum(self.calls.values()), "seconds_by_kind": {k: round(v, 1) for k, v in self.seconds.items()}, "errors": dict(self.errors), "cap": self.max_calls}


BUDGET: Budget | None = None


def claude(prompt: str, kind: str, model: str | None = None) -> str:
    assert BUDGET is not None
    BUDGET.spend(kind)
    cmd = ["claude", "-p", prompt] + (["--model", model] if model else [])
    t0 = time.time()
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired as err:
        BUDGET.errors[kind] += 1
        raise RuntimeError("claude timed out") from err
    finally:
        with BUDGET._lock:
            BUDGET.seconds[kind] += time.time() - t0
    if res.returncode != 0:
        BUDGET.errors[kind] += 1
        raise RuntimeError(f"claude exited {res.returncode}: {res.stderr[:200]}")
    return res.stdout


def bridge(cmd: str, payload: dict) -> dict:
    res = subprocess.run(["node", str(BRIDGE), cmd], input=json.dumps(payload), capture_output=True, text=True, timeout=60)
    if res.returncode != 0:
        raise RuntimeError(f"bridge {cmd} failed: {res.stderr[:300]}")
    return json.loads(res.stdout)


def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end > 0:
            return text[end + 5 :].strip()
    return text.strip()


def load_dataset() -> dict:
    path = HERE / "dataset.json"
    if not path.exists():
        sys.exit("eval/gepa/dataset.json is missing: run `node eval/gepa/build-dataset.mjs` (needs `cd mcp && npm run build`)")
    return json.loads(path.read_text())


# ---------------------------------------------------------------- generation --


def generation_prompt(guidance: str, ex: dict) -> str:
    code = (
        ["=== THE CODE JUST WRITTEN (often by a background agent; the developer has not read it) ===", f"File: {ex['source']}", "```", ex["code"], "```", ""]
        if ex.get("code")
        else ["=== THE CODE IS DELIBERATELY WITHHELD ===", "This focus returns context: null so the question reaches for the idea rather than the file.", ""]
    )
    return "\n".join(
        [
            "You are the Eklavya tutor. Follow the pedagogy below exactly.",
            "",
            "=== PEDAGOGY (fixed) ===",
            strip_frontmatter(SKILL_FILE.read_text()),
            "",
            "=== QUESTION-WRITING GUIDANCE (the part under test) ===",
            guidance,
            "",
            *code,
            "=== THE PLAN ITEM (authoritative) ===",
            json.dumps(ex["plan"], indent=2),
            "",
            "Write ONE multiple-choice question for this plan item.",
            "Reply with a single JSON object and nothing else:",
            '{"stem": "...", "options": ["...","...","...","..."], "descriptions": ["...","...","...","..."], "correct": <1-4>}',
            "`correct` is the 1-based index of the correct option as you ordered them.",
            "`descriptions` holds the `description` you would show under each option, in the same order.",
        ]
    )


def parse_question(raw: str, slug: str) -> dict | None:
    value = bridge("extract", {"text": raw}).get("value")
    if not isinstance(value, dict) or not value.get("stem") or not isinstance(value.get("options"), list):
        return None
    q = {"slug": slug, "stem": str(value["stem"]), "options": [str(o) for o in value["options"]], "correct": value.get("correct")}
    if isinstance(value.get("descriptions"), list):
        q["descriptions"] = [str(d) for d in value["descriptions"]]
    try:
        q["correct"] = int(q["correct"])
    except (TypeError, ValueError):
        q["correct"] = 0
    return q


def judge(q: dict, ex: dict) -> dict:
    item = {"description": ex["plan"].get("description"), "code_shown": bool(ex.get("code")), "diff": ex.get("code")}
    q2 = {**q, "tier_to_ask": ex["plan"]["tier_to_ask"]}
    out: dict = {}
    for kind, cmd, body in (("judge-audit", "audit-prompt", {"question": q2, "item": item}), ("judge-cold", "cold-prompt", {"question": q2})):
        try:
            parsed = bridge("extract", {"text": claude(bridge(cmd, body)["prompt"], kind)}).get("value")
        except BudgetExceeded:
            raise
        except Exception as err:  # a judge failure is reported, never silently scored
            parsed = {"_error": str(err)}
        out[kind] = parsed if isinstance(parsed, dict) else {"_error": "unparsable verdict"}
    return out


# ------------------------------------------------------------------- scoring --

GATES = ("structure", "rationale_free", "key_correct", "single_answer", "cold_answerable", "tier_match")


def score_question(q: dict, ex: dict, det: dict, verdict: dict) -> tuple[float, dict]:
    """Gates first, then quality. A candidate cannot earn quality on a question that fails a gate."""
    checks = {c["id"]: c for c in det["checks"]}
    audit, cold = verdict["judge-audit"], verdict["judge-cold"]
    judged = "_error" not in audit and "_error" not in cold
    gate = {
        "structure": all(checks[i]["ok"] for i in ("four_options", "correct_in_range", "answer_at_position")),
        "rationale_free": not (det["visible_problem"] or "").endswith("shown after the answer") and "explains the option" not in (det["visible_problem"] or ""),
        "key_correct": bool(audit.get("correct_is_correct")) if judged else False,
        "single_answer": audit.get("defensible_distractors") == 0 if judged else False,
        "cold_answerable": bool(cold.get("answerable_cold")) if judged else False,
        "tier_match": audit.get("tier_match") == "match" if judged else False,
    }
    visible = det["visible_words"]
    balanced = [det["visible_problem"] is None, checks["correct_not_conspicuous"]["ok"]]
    if "description_not_conspicuous" in checks:
        balanced.append(checks["description_not_conspicuous"]["ok"])
    # Padding guard: equal length reached by inflating every option is not a win.
    compact = max(visible, default=0) <= 35
    quality = {
        "balance": sum(balanced) / len(balanced),
        "plausible": (audit.get("plausible_distractors") or 0) / 3 if judged else 0.0,
        "stem": (checks["stem_length"]["ok"] + bool(audit.get("one_idea"))) / 2 if judged else 0.0,
        "compact": 1.0 if compact else 0.0,
    }
    failed = [g for g, ok in gate.items() if not ok]
    # A question that passes every gate always outranks one that does not
    # (0.5 + 0.5 * quality against at most 0.5 * gate fraction), so no amount of
    # polish buys back a wrong key. Failed questions are still ranked by how many
    # gates they pass, because a score that is 0 for all of them gives the search
    # nothing to climb: the shipped prompt passed every gate on only 1 of 12
    # validation questions in the first attempt, which scored a flat 0.06.
    fraction = (len(gate) - len(failed)) / len(gate)
    if failed:
        total = round(0.5 * fraction * (0.8 + 0.2 * quality["balance"]), 4)
    else:
        total = round(0.5 + 0.5 * (0.4 * quality["balance"] + 0.3 * quality["plausible"] + 0.15 * quality["stem"] + 0.15 * quality["compact"]), 4)
    info = {
        "score": total,
        "gates_failed": failed,
        "quality": quality,
        "visible_words_per_option": visible,
        "correct_option": q["correct"],
        "visible_problem": det["visible_problem"],
        "failed_checks": [f"{c['id']}: {c['detail']}" for c in det["checks"] if not c["ok"]],
        "judge": {k: v for k, v in {**audit, **{"cold_" + a: b for a, b in cold.items()}}.items() if k.endswith("_why") or k.startswith("_") or k in ("tier_match", "unexplained_names", "cold_unexplained_names")},
        "stem": q["stem"],
        "options": q["options"],
        "descriptions": q.get("descriptions"),
    }
    return total, info


def run_example(guidance: str, ex: dict) -> tuple[float, dict]:
    """One generation, then the deterministic checks, then (only if those pass) the judges."""
    try:
        raw = claude(generation_prompt(guidance, ex), "generate")
        q = parse_question(raw, ex["plan"]["slug"])
    except BudgetExceeded:
        raise
    except Exception as err:
        return 0.0, {"score": 0.0, "gates_failed": ["generation"], "error": str(err)}
    if q is None:
        return 0.0, {"score": 0.0, "gates_failed": ["generation"], "error": "no parsable question in the reply"}
    det = bridge("score", {"question": q, "answer_position": ex["plan"]["answer_position"], "tier_to_ask": ex["plan"]["tier_to_ask"]})
    checks = {c["id"]: c["ok"] for c in det["checks"]}
    if not all(checks.get(i) for i in ("four_options", "correct_in_range", "answer_at_position")):
        # Malformed: judging it would spend two calls to confirm a failure already known.
        verdict = {"judge-audit": {"_error": "skipped: malformed"}, "judge-cold": {"_error": "skipped: malformed"}}
    else:
        verdict = judge(q, ex)
    total, info = score_question(q, ex, det, verdict)
    info["longest"] = det["longest"]
    return total, info


# ------------------------------------------------------------------ commands --


def pick(dataset: dict, split: str, limit: int | None) -> list[dict]:
    rows = [e for e in dataset["examples"] if e["split"] == split]
    if limit is None or limit >= len(rows):
        return rows
    # Spread over fixtures instead of taking the first few, which would be one codebase.
    by_group: dict[str, list[dict]] = {}
    for r in rows:
        by_group.setdefault(r["group"], []).append(r)
    out, i = [], 0
    while len(out) < limit:
        for g in sorted(by_group):
            if i < len(by_group[g]) and len(out) < limit:
                out.append(by_group[g][i])
        i += 1
    return out


def cmd_evaluate(args) -> None:
    global BUDGET
    BUDGET = Budget(args.max_model_calls, args.max_minutes)
    guidance = strip_frontmatter(Path(args.prompt).read_text())
    rows = pick(load_dataset(), args.split, args.limit)
    jobs = [(ex, r) for ex in rows for r in range(args.repeats)]
    trials, stopped = [], None

    def one(job):
        ex, r = job
        total, info = run_example(guidance, ex)
        return {"id": ex["id"], "group": ex["group"], "repeat": r, "tier": ex["plan"]["tier_to_ask"], "focus": ex["focus"], **info}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(one, j) for j in jobs]
        for f in futures:
            try:
                trials.append(f.result())
            except BudgetExceeded as err:
                stopped = str(err)
    result = {"prompt": args.prompt, "split": args.split, "repeats": args.repeats, "examples": len(rows), "trials": trials, "stopped_early": stopped, "budget": BUDGET.summary(), "summary": summarise(trials)}
    Path(args.out).write_text(json.dumps(result, indent=1))
    print(json.dumps({"summary": result["summary"], "budget": result["budget"], "stopped_early": stopped}, indent=1))


def summarise(trials: list[dict]) -> dict:
    n = len(trials)
    gate_fail = Counter(g for t in trials for g in t.get("gates_failed", []))
    ok = [t for t in trials if not t.get("gates_failed")]
    longest = [t["longest"] for t in trials if t.get("longest")]

    def rate(key):
        rows = [l[key] for l in longest if l.get(key) is not None]
        return {"keyed_strictly_longest": sum(rows), "of": len(rows)}

    # Ties are reported separately: a keyed option tied for longest is not a leak
    # by itself, so the rate counts only strict leads.
    return {
        "trials": n,
        "all_gates_passed": len(ok),
        "gate_failures": dict(gate_fail),
        "mean_score": round(statistics.fmean(t["score"] for t in trials), 4) if trials else None,
        "mean_score_when_valid": round(statistics.fmean(t["score"] for t in ok), 4) if ok else None,
        "longest": {"label": rate("label"), "description": rate("description"), "combined": rate("combined")},
        "generation_errors": sum(1 for t in trials if "generation" in t.get("gates_failed", [])),
    }


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
    print(f"examples compared: {len(shared)}  candidate wins {wins}, losses {losses}, ties {len(shared) - wins - losses}")
    for name, r in (("baseline", base), ("candidate", cand)):
        s = r["summary"]
        print(f"\n{name}: {s['all_gates_passed']}/{s['trials']} pass every gate, mean score {s['mean_score']}, generation errors {s['generation_errors']}")
        print(f"  gate failures: {s['gate_failures']}")
        for k, v in s["longest"].items():
            print(f"  keyed option strictly longest by {k}: {v['keyed_strictly_longest']}/{v['of']}")
        print(f"  budget: {r['budget']['calls']}  stopped early: {r['stopped_early']}")


def cmd_optimize(args) -> None:
    global BUDGET
    import gepa.optimize_anything as oa  # imported late so `report` needs no GEPA install
    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    BUDGET = Budget(args.max_model_calls, args.max_minutes)
    dataset = load_dataset()
    train, val = pick(dataset, "train", args.train), pick(dataset, "val", args.val)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    seed = strip_frontmatter(SEED_FILE.read_text())

    def evaluator(candidate: str, example: dict):
        total, info = run_example(candidate, example)
        oa.log(json.dumps({k: v for k, v in info.items() if k in ("gates_failed", "failed_checks", "visible_words_per_option", "visible_problem", "judge", "error")}))
        return total, info

    def reflection_lm(prompt) -> str:
        return claude(prompt if isinstance(prompt, str) else json.dumps(prompt), "reflect")

    config = GEPAConfig(
        engine=EngineConfig(run_dir=str(out / "gepa-state"), seed=args.seed, max_metric_calls=args.metric_calls, max_workers=args.workers, raise_on_exception=False, display_progress_bar=False),
        reflection=ReflectionConfig(reflection_lm=reflection_lm, reflection_minibatch_size=args.minibatch),
    )
    stopped = None
    result = None
    try:
        result = optimize_anything(
            seed_candidate=seed,
            evaluator=evaluator,
            dataset=train,
            valset=val,
            objective=(
                "Rewrite the question-writing guidance so the tutor's multiple-choice questions give no hint of the answer through option length, "
                "specificity or pre-answer explanation, while keeping exactly one defensible answer, plausible distractors and a cold-readable stem."
            ),
            background=(
                "Hard rules a rewrite must keep: four options, exactly one defensible, the keyed option in the plan's answer_position slot, a stem of one learning objective, "
                "descriptions that state what an option claims and never why it is right or tempting. Do NOT make options equal length by padding distractors or cutting the "
                "correct option to a stub, and do not systematically make the keyed option shortest."
            ),
            config=config,
        )
    except BudgetExceeded as err:
        stopped = str(err)
    best = result.best_candidate if result else seed
    best = best if isinstance(best, str) else next(iter(best.values()))
    (out / "best_candidate.md").write_text(best + "\n")
    (out / "seed.md").write_text(seed + "\n")
    (out / "summary.json").write_text(json.dumps({"metric_calls": args.metric_calls, "train": len(train), "val": len(val), "seed": args.seed, "stopped_early": stopped, "budget": BUDGET.summary(), "gepa": "see pip freeze in README"}, indent=1))
    print(f"wrote {out}/best_candidate.md; budget {BUDGET.summary()}; stopped early: {stopped}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--max-model-calls", type=int, default=400, help="hard cap over generation, judging and reflection")
    common.add_argument("--max-minutes", type=float, default=90)
    common.add_argument("--workers", type=int, default=4)
    o = sub.add_parser("optimize", parents=[common])
    o.add_argument("--out", required=True)
    o.add_argument("--metric-calls", type=int, default=100)
    o.add_argument("--train", type=int, default=24, help="training examples (spread over fixtures)")
    o.add_argument("--val", type=int, default=12)
    o.add_argument("--minibatch", type=int, default=3)
    o.add_argument("--seed", type=int, default=0)
    e = sub.add_parser("evaluate", parents=[common])
    e.add_argument("--prompt", default=str(SEED_FILE))
    e.add_argument("--split", choices=("train", "val", "test"), default="test")
    e.add_argument("--limit", type=int, default=None)
    e.add_argument("--repeats", type=int, default=2)
    e.add_argument("--out", required=True)
    r = sub.add_parser("report")
    r.add_argument("baseline")
    r.add_argument("candidate")
    args = p.parse_args()
    {"optimize": cmd_optimize, "evaluate": cmd_evaluate, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main()
