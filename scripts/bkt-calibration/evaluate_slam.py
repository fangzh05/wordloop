"""Evaluate a source candidate using official chronological splits and past-only state."""
import argparse
import hashlib
import json
from pathlib import Path

from calibrate import FIXED, metrics
from slam import read_exercises


def evaluate(train, dev, test, candidate):
    import numpy as np
    state = {name: {} for name in ("fixed-v1", "source-candidate", "past-only-frequency")}
    last_day = {}
    result = {}
    for split, rows in (("train", train), ("dev", dev), ("test", test)):
        predictions = {name: [] for name in state}
        y = []
        for row in sorted(rows, key=lambda r: (r["user_id"], r["days"], r["order_id"])):
            user, outcome = row["user_id"], row["correct"]
            if row["days"] < last_day.get(user, -1):
                raise ValueError("Source split violates per-learner chronology")
            last_day[user] = row["days"]
            y.append(outcome)
            for name, params in (("fixed-v1", FIXED), ("source-candidate", candidate)):
                mastery = state[name].get(user, params["prior"])
                p = mastery*(1-params["slip"])+(1-mastery)*params["guess"]
                predictions[name].append(p)
                numerator = mastery*(1-params["slip"] if outcome else params["slip"])
                denominator = p if outcome else 1-p
                posterior = numerator/denominator
                state[name][user] = posterior+(1-posterior)*params["learn"]
            correct, count = state["past-only-frequency"].get(user, (1, 2))
            predictions["past-only-frequency"].append(correct/count)
            state["past-only-frequency"][user] = (correct+outcome, count+1)
        result[split] = {name: metrics(np.array(ps), np.array(y)) for name, ps in predictions.items()}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    files = {split: args.directory/f"en_es.slam.20190204.{split}" for split in ("train", "dev", "test")}
    train = read_exercises(files["train"])
    dev = read_exercises(files["dev"], files["dev"].with_suffix(".dev.key"))
    test = read_exercises(files["test"], files["test"].with_suffix(".test.key"))
    candidate = json.loads(args.candidate.read_text(encoding="utf-8"))
    report = {"source": candidate["source"], "license": candidate["license"],
              "params": candidate["params"], "source_fit": candidate["fit"],
              "splits": evaluate(train, dev, test, candidate["params"]),
              "source_files_sha256": {split: hashlib.sha256(file.read_bytes()).hexdigest()
                                      for split, file in files.items()},
              "key_files_sha256": {split: hashlib.sha256(
                  files[split].with_suffix(f".{split}.key").read_bytes()).hexdigest()
                  for split in ("dev", "test")},
              "unit": "all-correct reverse_translate exercise",
              "chronology_verified": True,
              "wordloop_transfer_validated": False,
              "production_parameters_changed": False}
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    print(json.dumps(report["splits"]))


if __name__ == "__main__":
    main()
