"""
What every GEPA target shares about trusting a result (issue #235), kept apart from the
runners so one self-check covers it: `python3 eval/gepa/decide.py`.

- the decision rule: how many fixtures and how large a difference count, written before a run
- finished-only vs all-trials means, so a timeout cannot hide inside a better-looking mean
- a length cap and the limits sentence the reflection model is told
- a test-split marker, and the warning `report` prints when a comparison is not like-for-like
"""
from __future__ import annotations

import hashlib
import statistics
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# A comparison over fewer fixtures than this is reported as "cannot decide".
MIN_FIXTURES = 8
# The smallest difference in mean score that counts, per target. Read off the runs themselves:
# the same prompt scored 0.003 apart on the observer and 0.16 apart on the feedback rubric.
MIN_DIFFERENCE = {"question": 0.05, "feedback": 0.10, "extraction": 0.05, "observer": 0.03, "dedup": 0.05}
# A candidate may not be longer than this many times the shipped text (feedback and observer have no
# file ceiling; prompt length is what makes the reviewer slow, so it is capped instead of scored).
LENGTH_RATIO = 1.25


def mean_scores(trials: list[dict]) -> tuple[float | None, float | None]:
    """(all trials, finished only). A trial that never finished (timeout, no reply) scores 0 in the first
    and is left out of the second, so a prompt that is good only when it finishes shows as two numbers."""
    done = [t for t in trials if not t.get("error")]
    mean = lambda rows: round(statistics.fmean(t["score"] for t in rows), 4) if rows else None
    return mean(trials), mean(done)


def verdict(target: str, base: dict[str, float], cand: dict[str, float]) -> str:
    """One line: what the comparison can and cannot say, from per-fixture mean scores."""
    shared = sorted(set(base) & set(cand))
    if len(shared) < MIN_FIXTURES:
        return f"cannot decide: {len(shared)} fixtures compared, the rule needs {MIN_FIXTURES}"
    diff = statistics.fmean(cand[k] for k in shared) - statistics.fmean(base[k] for k in shared)
    floor = MIN_DIFFERENCE[target]
    if abs(diff) < floor:
        return f"no difference: mean {diff:+.3f}, under the {floor} the {target} rule requires"
    return f"{'candidate better' if diff > 0 else 'candidate worse'}: mean {diff:+.3f} (rule: at least {floor} over {MIN_FIXTURES}+ fixtures)"


def length_cap(shipped: str) -> int:
    return int(len(shipped.split()) * LENGTH_RATIO)


def over_cap(text: str, cap: int) -> int:
    return max(0, len(text.split()) - cap)


def reject_over_cap(text: str, cap: int) -> tuple[float, dict] | None:
    """The trial a candidate over the cap gets instead of a model call; None when it fits."""
    over = over_cap(text, cap)
    if not over:
        return None
    return 0.0, {"score": 0.0, "gates_failed": ["length_cap"], "error": f"{over} words over the {cap}-word cap"}


def proposal_counts(trials: list[dict]) -> dict:
    """Candidates the search proposed, and how many were turned away unscored (a length cap or the word ceiling).
    Written to `summary.json`, because a search whose proposals are mostly rejected is not searching."""
    rejected: dict[str, bool] = {}
    for t in trials:
        if "candidate" in t:
            rejected[t["candidate"]] = rejected.get(t["candidate"], False) or bool({"length_cap", "word_ceiling"} & set(t.get("gates_failed", [])))
    n = sum(rejected.values())
    return {"proposals": len(rejected), "scored": len(rejected) - n, "rejected_unscored": n}


def limits_note(what: str, shipped_words: int, limit: int, headroom_note: str = "") -> str:
    """The sentence for the reflection prompt, so the search does not spend proposals the harness rejects unscored."""
    return (
        f"Length limit for {what}: the shipped text is {shipped_words} words, the most a rewrite may have is {limit} words "
        f"({limit - shipped_words:+d} against the shipped text). A rewrite over the limit is rejected without being run and scores 0.{headroom_note}"
    )


def _git(*args: str) -> str:
    got = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)
    return got.stdout.strip() if got.returncode == 0 else ""


def marker(split: str, fixture_ids: list[str], prompt: str, code_paths: list[str]) -> dict:
    """Written into every `evaluate` result. `code` is the last commit that touched the harness and the code
    it scores with, plus whether those files have uncommitted edits, so two results from different matcher
    or scorer versions are visibly different."""
    ids = hashlib.sha1("\n".join(sorted(set(fixture_ids))).encode()).hexdigest()[:10]
    dirty = bool(_git("status", "--porcelain", "--", *code_paths))
    return {
        "split": split,
        "fixtures": ids,
        "prompt": hashlib.sha1(prompt.encode()).hexdigest()[:10],
        "code": _git("log", "-1", "--format=%h", "--", *code_paths) + ("+uncommitted" if dirty else ""),
    }


def warnings(base: dict, cand: dict) -> list[str]:
    """What `report` prints above a comparison. Empty means the two runs are like-for-like."""
    a, b = base.get("marker"), cand.get("marker")
    if not a or not b:
        return ["a result has no test-split marker (it predates #235), so its split and code version are unverified"]
    out = []
    if a["split"] != b["split"] or a["fixtures"] != b["fixtures"]:
        out.append(f"different fixtures: {a['split']}/{a['fixtures']} vs {b['split']}/{b['fixtures']}")
    if a["code"] != b["code"]:
        out.append(f"the harness or scorer changed between the runs ({a['code']} vs {b['code']}): the baseline is not comparable; re-run it")
    if a["split"] == "test" and a["prompt"] == b["prompt"]:
        out.append("both runs used the same prompt: this measures noise, not a candidate")
    return out


def models_line(budget: dict) -> str:
    m = budget.get("models") or {}
    return ", ".join(f"{k}={'/'.join(v)}" for k, v in sorted(m.items())) or "not recorded"


if __name__ == "__main__":
    t = [{"score": 0.8}, {"score": 0.6}, {"score": 0.0, "error": "did not finish"}]
    assert mean_scores(t) == (0.4667, 0.7)
    assert verdict("feedback", {"a": 0.5}, {"a": 0.9}).startswith("cannot decide")
    ids = [f"f{i}" for i in range(8)]
    assert verdict("feedback", dict.fromkeys(ids, 0.5), dict.fromkeys(ids, 0.55)).startswith("no difference")
    assert verdict("feedback", dict.fromkeys(ids, 0.5), dict.fromkeys(ids, 0.7)).startswith("candidate better")
    assert over_cap("a b c d", 3) == 1 and over_cap("a b c", 3) == 0
    m = {"split": "test", "fixtures": "x", "prompt": "p1", "code": "abc"}
    assert warnings({"marker": m}, {"marker": {**m, "prompt": "p2"}}) == []
    assert len(warnings({"marker": m}, {"marker": {**m, "prompt": "p2", "code": "def"}})) == 1
    assert len(warnings({}, {"marker": m})) == 1
    assert "-3" in limits_note("x", 10, 7)
    assert reject_over_cap("a b", 2) is None and reject_over_cap("a b c", 2)[1]["gates_failed"] == ["length_cap"]
    assert proposal_counts([{"candidate": "a", "gates_failed": ["word_ceiling"]}, {"candidate": "a"}, {"candidate": "b"}, {"id": "x"}]) == {"proposals": 2, "scored": 1, "rejected_unscored": 1}
    print("decide.py: ok")
