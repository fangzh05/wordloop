"""Import official en_es SLAM data; fit an offline exercise-production candidate."""
import argparse
import hashlib
import json
from pathlib import Path

from source_fit import fit_source


def read_exercises(path, key_path=None):
    key = {}
    if key_path:
        for line in key_path.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) != 2 or parts[1] not in ("0", "1") or parts[0] in key:
                raise ValueError("Invalid/duplicate SLAM key")
            key[parts[0]] = int(parts[1])
    rows, metadata, tokens = [], {}, []
    def flush():
        if not tokens:
            return
        # Free production only. No word-bank guesses and no transcription-only listening.
        if metadata.get("format") == "reverse_translate":
            user = metadata.get("user")
            if not user or "days" not in metadata:
                raise ValueError("Missing user/time metadata")
            rows.append({"user_id": user, "days": float(metadata["days"]),
                         "correct": int(all(label == 0 for label in tokens)),
                         "skill_name": "lexical_production", "order_id": len(rows)})
        tokens.clear()
    for line in path.read_text(encoding="utf-8").splitlines()+[""]:
        if not line.strip():
            flush()
            metadata = {}
        elif line.startswith("#"):
            for part in line[1:].split():
                if ":" in part:
                    name, value = part.split(":", 1)
                    metadata[name] = value
        else:
            fields = line.split()
            if len(fields) not in (6, 7):
                raise ValueError("Invalid SLAM token row")
            if key_path:
                if fields[0] not in key:
                    raise ValueError("Missing outcome in key")
                label = key.pop(fields[0])
            else:
                if len(fields) != 7 or fields[-1] not in ("0", "1"):
                    raise ValueError("Training data requires binary mistake label")
                label = int(fields[-1])
            tokens.append(label)
    if key:
        raise ValueError("Unused key labels")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows = read_exercises(args.train)
    if not rows:
        raise ValueError("No independent reverse_translate exercises")
    rows.sort(key=lambda row: (row["user_id"], row["days"], row["order_id"]))
    print(json.dumps({"phase": "fit", "exercises": len(rows),
                      "learners": len({r["user_id"] for r in rows})}), flush=True)
    fitted = fit_source(rows)
    params = fitted["params"]
    result = {"protocol": "slam-exercise-production-v1", "params": params,
              "source": "https://doi.org/10.7910/DVN/8SWHNO", "dataset_version": "4.0",
              "license": "CC BY-NC 4.0", "training_sha256": hashlib.sha256(args.train.read_bytes()).hexdigest(),
              "training_exercises": len(rows), "training_learners": len({r["user_id"] for r in rows}),
              "label_rule": "Token label 1 is a mistake; exercise correct only if all tokens have label 0",
              "format": "reverse_translate", "no_forgetting": True, "seed": 20261004,
              "status": "offline-candidate-requires-WordLoop-gate",
              "fit": fitted, "engine": "exact-forward-likelihood-scipy-numba"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    print(json.dumps({"exercises": len(rows), "learners": result["training_learners"], "params": params}))


if __name__ == "__main__":
    main()
