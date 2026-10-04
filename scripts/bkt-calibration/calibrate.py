"""Offline BKT fitting and chronological validation. Never writes production state."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

FIXED = {"prior": .2, "learn": .1, "guess": .2, "slip": .1}
SEED = 20261004
# Registered before opening holdout metrics. A support floor alone does not prove efficacy.
POLICY = {"train_fraction": .6, "validation_fraction": .2,
          "minimum_class_count_per_split": 10, "bootstrap_samples": 2000,
          "bootstrap_block_length": 5, "confidence": .95,
          "requires": ["both losses beat fixed and past-only frequency",
                       "paired block bootstrap upper bound below zero for both losses",
                       "both labels supported in every split"]}
KEYS = tuple(FIXED)


def predict(rows, params):
    mastery = params["prior"]
    predictions = []
    for row in rows:
        probability = mastery * (1 - params["slip"]) + (1 - mastery) * params["guess"]
        predictions.append(float(np.clip(probability, 1e-9, 1 - 1e-9)))
        correct = row["outcome"] == "correct"
        mastered = mastery * (1 - params["slip"] if correct else params["slip"])
        unmastered = (1 - mastery) * (params["guess"] if correct else 1 - params["guess"])
        posterior = mastered / max(mastered + unmastered, 1e-15)
        mastery = posterior + (1 - posterior) * params["learn"]
    return np.array(predictions)


def labels(rows):
    return np.array([float(r["outcome"] == "correct") for r in rows])


def losses(predictions, y):
    p = np.clip(predictions, 1e-9, 1 - 1e-9)
    return {"brier": (p-y)**2, "log_loss": -y*np.log(p)-(1-y)*np.log1p(-p)}


def metrics(predictions, y):
    if not len(y):
        return {"count": 0, "correct": 0, "brier": None, "log_loss": None}
    return {"count": len(y), "correct": int(y.sum()),
            **{key: float(value.mean()) for key, value in losses(predictions, y).items()}}


def fit_local(train, penalty):
    """MAP-style sensitivity fits. Train only; validation chooses the candidate."""
    y = labels(train)
    def objective(values):
        params = dict(zip(KEYS, values))
        likelihood = losses(predict(train, params), y)["log_loss"].sum()
        return float(likelihood + penalty * sum((params[k]-FIXED[k])**2 for k in KEYS))
    bounds = [(1e-4, 1-1e-4), (1e-4, .5), (1e-4, .49), (1e-4, .49)]
    starts = [list(FIXED.values()), [.5, .02, .1, .3], [.1, .01, .3, .2]]
    results = [minimize(objective, start, method="L-BFGS-B", bounds=bounds) for start in starts]
    valid = [r for r in results if r.success and np.isfinite(r.fun)]
    if not valid:
        raise ValueError("All training optimizers failed")
    winner = min(valid, key=lambda r: r.fun)
    return {k: float(v) for k, v in zip(KEYS, winner.x)}


def frequency(rows):
    # Beta(1,1), prediction before the current outcome; no holdout look-ahead.
    successes, count = 1, 2
    probabilities = []
    for row in rows:
        probabilities.append(successes / count)
        successes += row["outcome"] == "correct"
        count += 1
    return np.array(probabilities)


def paired_intervals(candidate, baseline, y):
    """Moving-block diagnostic CI for one learner, not a population causal estimate."""
    if not len(y):
        return {}
    rng = np.random.default_rng(SEED)
    block = min(POLICY["bootstrap_block_length"], len(y))
    indices = []
    for _ in range(POLICY["bootstrap_samples"]):
        # Non-circular contiguous blocks keep the original neighboring outcomes.
        starts = rng.integers(0, len(y)-block+1, math.ceil(len(y)/block))
        indices.append(np.concatenate([np.arange(s, s+block) for s in starts])[:len(y)])
    indices = np.array(indices)
    candidate_loss, baseline_loss = losses(candidate, y), losses(baseline, y)
    return {k: {"difference": float((candidate_loss[k]-baseline_loss[k]).mean()),
                "interval_95": [float(x) for x in np.quantile(
                    (candidate_loss[k]-baseline_loss[k])[indices].mean(axis=1), [.025, .975])]}
            for k in candidate_loss}


def trusted_rows(snapshot):
    seen = set()
    accepted = []
    for row in sorted(snapshot["rows"], key=lambda r: (r["created_at"], r["id"])):
        # Snapshot query already deduplicates owned exercise/skill and peer contradictions.
        if row["id"] in seen:
            raise ValueError("Duplicate evidence ID")
        seen.add(row["id"])
        if row.get("deterministic_audit") is not True:
            continue
        if (row["quality"] != "OBSERVE" or row["outcome"] not in ("correct", "incorrect")
            or not row["first_unprompted"] or row["hint_used"] or row["answer_revealed"]
            or row["modified_correct"]):
            continue
        accepted.append(row)
    return accepted


def evaluate_skill(rows, source_params=None):
    n = len(rows)
    train_end, validation_end = int(n*.6), int(n*.8)
    if train_end == 0 or validation_end == train_end or validation_end == n:
        return {"count": n, "eligible": False, "reasons": ["Insufficient chronological split"]}
    train = rows[:train_end]
    candidates = {"fixed-v1": FIXED,
                  "local-mle": fit_local(train, 0),
                  "local-shrunk": fit_local(train, 2)}
    if source_params is not None:
        candidates["slam-exercise-production"] = source_params
    validation = slice(train_end, validation_end)
    test = slice(validation_end, n)
    y = labels(rows)
    probabilities = {name: predict(rows, params) for name, params in candidates.items()}
    # Select with validation only. Fixed participates, so a worse candidate is never favored.
    selected = min(candidates, key=lambda name: metrics(probabilities[name][validation], y[validation])["log_loss"])
    baselines = {"fixed-v1": probabilities["fixed-v1"], "past-only-frequency": frequency(rows)}
    comparisons = {name: paired_intervals(probabilities[selected][test], p[test], y[test])
                   for name, p in baselines.items()}
    splits = {"train": rows[:train_end], "validation": rows[train_end:validation_end],
              "test": rows[validation_end:]}
    support = {name: {"count": len(rs), "correct": int(labels(rs).sum()),
                     "incorrect": len(rs)-int(labels(rs).sum())} for name, rs in splits.items()}
    reasons = []
    if selected == "fixed-v1":
        reasons.append("Validation retained fixed-v1")
    if any(min(s["correct"], s["incorrect"]) < POLICY["minimum_class_count_per_split"]
           for s in support.values()):
        reasons.append("Both outcome classes lack the predeclared split support")
    if any(c[k]["difference"] >= 0 for c in comparisons.values() for k in c):
        reasons.append("Candidate does not improve both test losses against both baselines")
    if any(c[k]["interval_95"][1] >= 0 for c in comparisons.values() for k in c):
        reasons.append("Loss improvement is not supported by both paired intervals")
    return {"count": n, "splits": support, "selected_on_validation": selected,
            "candidates": {name: {"params": params,
                                  "validation": metrics(probabilities[name][validation], y[validation]),
                                  "test": metrics(probabilities[name][test], y[test])}
                           for name, params in candidates.items()},
            "frequency_test": metrics(baselines["past-only-frequency"][test], y[test]),
            "paired_test": comparisons, "eligible": not reasons, "reasons": reasons}


def run(snapshot, source_params=None):
    rows = trusted_rows(snapshot)
    skills = sorted({r["skill_id"] for r in rows})
    return {"protocol": "wordloop-bkt-calibration-v1", "seed": SEED, "policy": POLICY,
            "snapshot_at": snapshot["captured_at"], "total_snapshot_rows": len(snapshot["rows"]),
            "trusted_observations": len(rows), "human_gold_count": snapshot["human_gold_count"],
            "source_candidate_available": source_params is not None,
            "limitations": ["One learner; intervals are diagnostic and not learning-effect evidence",
                "Automatic exact-answer audit is not a human gold label or semantic mastery assessment",
                "Only audited independent observations replayed; this is a controlled benchmark, not a full production-state replay",
                "SLAM exercise correctness combines multiple causes; skill transfer requires a separate WordLoop gate"],
            "skills": {skill: evaluate_skill([r for r in rows if r["skill_id"] == skill],
                       source_params if skill == "target_sense_retrieval" else None)
                       for skill in skills},
            "production_parameters_changed": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--source-candidate", type=Path)
    parser.add_argument("--opened-holdout", action="store_true",
                        help="Descriptive rerun only: do not promote after a holdout was disclosed")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw = args.snapshot.read_bytes()
    source = json.loads(args.source_candidate.read_text(encoding="utf-8")) if args.source_candidate else None
    if source is not None:
        source = source["params"]
        if set(source) != set(KEYS) or any(not 0 <= source[k] <= 1 for k in KEYS):
            raise ValueError("Invalid source candidate")
        if source["guess"] + source["slip"] >= 1:
            raise ValueError("Source candidate has no monotonic mastery interpretation")
    report = run(json.loads(raw), source)
    report["holdout_already_opened"] = args.opened_holdout
    if args.opened_holdout:
        for skill in report["skills"].values():
            skill["eligible"] = False
            skill.setdefault("reasons", []).append("Opened holdout is descriptive only; fresh validation required")
    report["snapshot_sha256"] = hashlib.sha256(raw).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False)+"\n", encoding="utf-8")
    print(json.dumps({"report": str(args.output),
                      "eligible": {k: v["eligible"] for k, v in report["skills"].items()},
                      "production_parameters_changed": False}))


if __name__ == "__main__":
    main()
