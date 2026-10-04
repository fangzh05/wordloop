# WordLoop BKT offline calibration

This tool never writes to Supabase or changes runtime parameters. Runtime remains
`fixed-v1` until a candidate clears a chronological WordLoop holdout gate and a
separate versioned deployment is implemented. FSRS and frozen sessions are untouched.

Use Python 3.12 and an isolated virtual environment:

```powershell
python -m venv .bkt-calibration/venv
.bkt-calibration/venv/Scripts/python -m pip install -r scripts/bkt-calibration/requirements.txt
.bkt-calibration/venv/Scripts/python -m unittest discover -s scripts/bkt-calibration -p "test_*.py" -v
.bkt-calibration/venv/Scripts/python scripts/bkt-calibration/calibrate.py --snapshot .bkt-calibration/wordloop-snapshot.json --output .bkt-calibration/report.json
```

Export `snapshot.sql` with the authenticated learner bound as `$1`, using a
read-only service-role query. Keep this private, local snapshot outside version
control. It excludes account IDs, answers, word text, and event payloads; retain the
snapshot timestamp and SHA-256. A deterministic audit is not a human gold label.
The importer keeps audited, independent, first unprompted OBSERVE outcomes only.
Unreviewed Lesson events, hints, reveals, corrections, and peer contradictions are excluded.

Each skill is split chronologically 60% train / 20% validation / 20% test, never
randomly by row. Three initializations fit bounded four-parameter models without
forgetting, using either likelihood alone or a weak squared-distance penalty of
2 against fixed parameters. Validation selects among fixed, local MLE, and local
shrinkage models. Test outcomes do not select or refit parameters; they update
mastery only after the corresponding prediction. The frequency comparator also
uses past outcomes only, with Beta(1,1) smoothing.

A release candidate must improve Brier and log loss against both fixed and
past-only frequency; the paired moving-block 95% interval must stay below zero for
both metrics. Every split must contain at least ten outcomes of each class.
These are predeclared screening rules, not proof that learning improves. This
single-learner experiment cannot establish population efficacy. Once the holdout
has been opened, freeze it as a historical report; validate a revised candidate on
a future fresh holdout.

## Optional SLAM source candidate

Official source: Burr Settles (2018), *Data for the 2018 Duolingo Shared Task on
Second Language Acquisition Modeling (SLAM)*, Harvard Dataverse V4,
[doi:10.7910/DVN/8SWHNO](https://doi.org/10.7910/DVN/8SWHNO).
[Task schema](https://sharedtask.duolingo.com/2018.html).
License: CC BY-NC 4.0. Download requires the owner guestbook and acceptance of the
terms. Provide real identity fields and explicitly approve the download terms;
do not invent fields or silently bypass the owner guestbook.
Keep raw data and derived artifacts local and use within the noncommercial terms.

The English `en_es` track is English learned by Spanish speakers. SLAM token label
**1 means mistake**. `slam.py` restricts to `reverse_translate`, grouping tokens
into one exercise outcome (all tokens correct) to avoid treating correlated
tokens as independent practice. Word-bank `reverse_tap` and listening are excluded.
Exercise correctness combines semantics, grammar, and spelling; it does not
supply canonical WordLoop skill labels. It is an exploratory lexical-production
candidate for the retrieval gate, and is never applied directly to spelling.
The official train/dev/test files have chronological splits. Train alone fits
five deterministic initializations of the exact forward likelihood, without
forgetting. SciPy optimizes bounded parameters; Numba accelerates the same Bayesian
recurrence used by the runtime. The analytic gradient is checked against finite
differences, and sequence loss against the runtime recurrence:

```powershell
.bkt-calibration/venv/Scripts/python scripts/bkt-calibration/slam.py --train .bkt-calibration/en_es.slam.20190204.train --output .bkt-calibration/slam-candidate.json
.bkt-calibration/venv/Scripts/python scripts/bkt-calibration/evaluate_slam.py --directory .bkt-calibration --candidate .bkt-calibration/slam-candidate.json --output .bkt-calibration/slam-validation-report.json
.bkt-calibration/venv/Scripts/python scripts/bkt-calibration/calibrate.py --snapshot .bkt-calibration/fresh-wordloop-snapshot.json --source-candidate .bkt-calibration/slam-candidate.json --output .bkt-calibration/slam-wordloop-report.json
```

The evaluation CLI verifies dev/test key joins and per-learner split chronology,
then reports Brier and log loss against fixed and past-only frequency while
carrying past learner state between splits. Source training alone does not
validate transfer. A fresh local gate is still required before release. For
cross-language demographic and exercise-format shifts, only a WordLoop validation
result can justify transfer. If rerunning an already disclosed local holdout,
pass --opened-holdout: all comparisons are descriptive and promotion is disabled.

Reports contain aggregate counts, candidate parameters, prediction losses,
intervals, and rejection reasons. Raw snapshots and answer labels stay local.
