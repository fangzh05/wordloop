# Evidence and daily time budget

The default is 45 minutes per local day. The existing daily new-word limit remains a ceiling. The Today progress card includes the time budget and can add 15 minutes once per request ID. Time editing is collapsed by default; the existing seven-day due panel shows estimated costs. Settings contains the advanced evidence export and human labeling tools. These routes require the existing web bearer token; every query is scoped to the configured learner.

## Boundaries

- FSRS alone owns card due times, parameters, retention and formal review ratings. Formal review formats are unchanged. Due cards are sorted by lowest FSRS retrievability first; error persistence breaks ties.
- Evidence normalizes declared skills only. Unknown skills, contradictory labels, partial and unassessed outcomes cannot become binary observations. Independent first answers are OBSERVE; assisted completion is LEARN_ONLY; unusable evidence is IGNORE. A visible target cannot demonstrate recall.
- Fixed BKT parameters are prior .2, learn .1, guess .2, slip .1. OBSERVE performs Bayesian correction followed by learning; LEARN_ONLY performs learning only. Historical unversioned evidence is excluded. One exercise updates a skill once; inconsistent multiword outcomes are ignored. Projection uses revision checks and ordered replay. A failure leaves durable evidence pending without blocking a saved answer.
- Tutor BKT recommendations are recorded in shadow mode only. The deterministic planner still chooses the live exercise. Shadow mastery is uncalibrated and must not be presented as demonstrated competence.
- Budget admission never writes a review or shifts due dates. Uncompleted cards remain due. Frozen sessions and saved answers survive a budget pause. Reserved task IDs are idempotent, including retries after model failures. Estimates measure scheduled work, not elapsed time.

## Costs and workload

Recall costs 8 seconds, collocation/derivation 15, translation 30, sentence/application 45, and consolidation 90. Lesson reservations include 30 seconds for explanation. New-word admission uses 77 seconds per word, including pretest, explanation, a translation exercise and amortized consolidation. Overdue work blocks new admissions. Remaining time and a seven-day no-fuzz FSRS Good-only simulation further cap new words. The simulation uses disposable cards and assumes the same number of new words each day. Existing due-date forecasts count currently scheduled reviews, not future repeats or actual human timing. This is a conservative admission heuristic, not a fitted workload model; a sentence-heavy round can pause sooner.

## Evaluation

The export includes at most 200 current-version samples and metrics from at most 1,000 observations. Email addresses, URLs, UUIDs and mobile numbers in samples are masked. Human labels are separate from model labels. Only explicitly reviewed samples count as gold. Synthetic regression cases test the contract; they are not real human judgments. Empty metrics are null rather than a fabricated accuracy.

The report exposes per-skill outcome precision/recall, per-error-label precision/recall, observation coverage, rejected counts, Brier score, log loss and calibration bins. Frequency and correct-streak baselines use only preceding outcomes within the exported window. The fixed-prior baseline is also reported. None of these automatically enables Tutor selection. Collect and manually review a representative real set before drawing accuracy conclusions or fitting parameters offline with pyBKT.

## Migration and recovery

Apply `20261002024106_evidence_budget.sql` after the existing balanced exercise-plan and note-review migrations, then deploy the matching server. New tables have RLS and no browser grants; RPCs are service-role only. Formal-review evidence is inserted in the same transaction as the existing attempt and FSRS write. The migration does not backfill historical correctness.

Use `npm run evidence:replay` with the existing server environment to drain pending evidence for the configured learner. It resumes projection without rewriting source evidence or FSRS. A capped run reports remaining backlog and can be repeated. To disable BKT projection, set that learner's `learning_settings.bkt_mode` to `off` through an authorized database operation. `budget_enabled=false` disables admission without altering cards or history. Re-enable explicitly after diagnosis. Preserve the additive migration when rolling back the app; an old app will not consume the new shadow state.

Validation includes pure contract/BKT tests, actual PostgreSQL-compatible transaction tests via PGlite, web authorization checks, typecheck, full tests and the Sites build. The database schema checker probes the additive tables and read-only RPCs. No OATutor, pyBKT, LanguageTool, Cost ADR, bandit, or dynamic retention runtime is introduced.
