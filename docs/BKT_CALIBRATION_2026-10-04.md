# 2026-10-04 BKT calibration experiment

**Decision: retain fixed-v1. No calibration candidate is approved for production.**
The learner remains in active mode using fixed parameters. This experiment does
not change FSRS scheduling or any frozen learning session.

The snapshot was frozen at 2026-10-04 05:21:28 UTC (13:21:28 China time).
126 binary evidence rows were exported; 124 passed deterministic, independent
exact-answer audits (92 retrieval, 32 spelling). Two Lesson rows lack independent
audit and were excluded. There are zero human gold labels. The snapshot SHA-256 is
`bfeef76424791ff396e75c7c5574a0463773bf4b04261c2b1521dd0211a12de7`.
Private input remains outside Git.

The protocol was fixed before opening test metrics: chronological 60/20/20;
train-only likelihood and shrinkage fits; validation-only candidate selection;
test loss comparison against fixed and past-only frequency. Promotion requires
both losses to improve with paired block interval support and both classes to
have at least ten observations in every split.

| Skill | Train correct/incorrect | Validation correct/incorrect | Test correct/incorrect |
|---|---:|---:|---:|
| Retrieval | 16 / 39 | 5 / 13 | 10 / 9 |
| Spelling | 19 / 0 | 5 / 1 | 7 / 0 |

Lower loss is better:

| Retrieval model | Test Brier | Test log loss |
|---|---:|---:|
| fixed-v1 | 0.271258 | 0.759438 |
| Validation-selected local shrinkage | 0.304861 | 0.813041 |
| Past-only frequency | 0.296071 | 0.792351 |

Retrieval shrinkage was better on validation but worse on test.
Its Brier difference vs fixed was +0.033603 (diagnostic paired block 95% interval
[-0.124142, +0.134940]); log loss difference was +0.053603
([-0.300735, +0.262491]). Fitted prior and learning probabilities reached their
lower bound of 0.0001, another sign that four parameters cannot be interpreted
reliably from this small, changing sequence. This candidate must not be promoted.

Spelling validation selected fixed-v1. There was only one spelling error in the
entire stream; no error occurred in train or test. Near-perfect predictions on
seven correct test answers do not identify slip/guess parameters.

These are within-learner prediction checks on audited exact-answer outcomes,
not human semantic gold labels or a causal study of improved learning.
The benchmark replays the audited stream, rather than all production observations.
The 95% intervals are approximate single-learner moving-block diagnostics.

## Public SLAM experiment

The official English en_es V4 dataset was downloaded after explicit user
authorization of the owner guestbook and CC BY-NC 4.0 terms. Its archive MD5 matches
the publisher: 444e0d9e45bdc19822938cffb9fbcc7a. Identity fields and raw data remain
outside Git. Source: Burr Settles (2018), Harvard Dataverse V4,
[doi:10.7910/DVN/8SWHNO](https://doi.org/10.7910/DVN/8SWHNO).

Token label 1 means a mistake. We grouped each reverse_translate exercise into
one all-correct outcome, excluding word-bank and listening exercises. This is
an exploratory production model; errors combine several skill causes and cannot
be treated as canonical WordLoop semantic or spelling labels.

Training used 327,550 exercises from 2,593 learners. The official chronological
dev and test splits contain 48,209 and 47,253 retained exercises. The exact
no-forgetting forward likelihood used five fixed starts; two converged and the
best converged fit was selected by training likelihood alone. Parameters:

| Parameter | Candidate |
|---|---:|
| prior | 0.590688 |
| learn | 0.001078 |
| guess | 0.482078 |
| slip | 0.284177 |

| SLAM model | Dev Brier | Dev log loss | Test Brier | Test log loss |
|---|---:|---:|---:|---:|
| fixed-v1 | 0.294914 | 0.891486 | 0.301345 | 0.901375 |
| Source candidate | 0.232741 | 0.658352 | 0.235455 | 0.664135 |
| Past-only frequency | 0.229600 | 0.651997 | 0.231817 | 0.656369 |

The source candidate improves on fixed-v1 but still loses to the simple
frequency baseline on both external holdouts.

On the already opened WordLoop retrieval test, its Brier is 0.250942 and log loss
0.695031. This is a descriptive transfer check only: adding a candidate after the
holdout disclosure does not supply a new independent acceptance test.
Validation still chooses the local shrinkage model, whose test performance failed
the original gate. The tool explicitly disables promotion for this opened-holdout
rerun. Spelling receives no direct SLAM mapping.

The initial pyBKT 1.4.1 Windows wheel produced nonfinite output: its imported
EM implementation skipped the E-step under a main-module guard. That run was
rejected. The final engine uses a separately verified exact likelihood and
analytic gradient, and rejects nonfinite or unconverged results.

Eight offline tests and 677 application tests passed; two credential-dependent
integration tests were skipped. Typecheck, build and MCP Inspector passed.
No candidate passed the production gate, so the current active fixed-v1 release
v132 remains live and no new calibration deployment was published.

See [the offline workflow](../scripts/bkt-calibration/README.md) and the aggregate
JSON reports in docs/bkt-calibration/. A future candidate requires a fresh
chronological WordLoop holdout. Do not tune against the disclosed test outcomes
here or relabel automatic audits as human gold.
