# Independent Statistical Review — WordLoop Timing Metrics

**Scope note:** Review based on the provided aggregates and your code-review confirmation. No data or code was modified.

## 1. Claims that cannot be supported

- **Any statement about active study time** — `active_ms` has zero non-null samples across all activity types. There is no distribution, no mean, no P50/P90, no variance. n = 0 means "unmeasured," not "zero."
- **Any estimator comparison on active time** (P50 vs P75 vs trimmed mean vs EWMA vs shrinkage) — a backtest requires realized outcomes to score against. With no ground truth, a "winning" estimator reflects your priors, not evidence.
- **Per-user conclusions** — 4 users. No population inference is possible; all session-level statistics are nested within user idiosyncrasy (~16 sessions/user).
- **Feedback-timing claims** — no feedback timing data exists at all.
- **Using the 1008 estimated-budget events as ground truth** — circular if those estimates were produced by the very estimator under evaluation.
- **Grading coverage** — 410 `grading_ms` samples against 1061 submission events (~39%). Verify which submissions get timed; if selection is non-random, even grading percentiles are biased.
- **Historical dashboards showing "active time"** — since the code confirms `active_ms: null` at formal submission, any displayed active-time values are fallback/imputed artifacts. Flag as misleading.

## 2. Can zero-sample history choose a winning algorithm?

**No.** Model selection requires a loss evaluated on data. With n = 0 for the target quantity, choosing among P50/P75/trimmed/EWMA/shrinkage is prior selection wearing evaluation's clothes. The honest output today is: report the static fallback, label active-time metrics "not measurable," and defer the choice. Backtests on proxy quantities (`grading_ms`, session durations) can validate pipeline correctness and leakage hygiene — but they do not select an active-time estimator, because grading latency and engagement time have different distributions and drivers.

## 3. The proposed pilot estimator

Five-second histograms + P90-winsorized mean + `n/(n+20)` shrinkage to a static fallback is a reasonable, conservative shape. Specific concerns:

- **Empirical P90 with tiny n is the max.** With n < 10, the P90 is essentially the largest observation — winsorization becomes max-clipping and is unstable. Prefer a **fixed, domain-motivated cap** (e.g., a constant per-attempt ceiling set a priori) over an empirical quantile until n is comfortably large.
- **The fallback constant is an assumption, not a measurement.** Document where it comes from (design expectation, literature, pilot) and keep it versioned — it is load-bearing when n is small.
- **k = 20 chosen without data is a prior-strength claim**: "at 20 observations we trust data half-and-half." Too small → early estimates jump with each attempt; too large → the system ignores real signal. You cannot resolve this yet; pre-commit to a value, log it, and make it a decision variable in the future protocol rather than tuning it informally now.
- **Shrinkage target**: shrinking to a per-user fallback is tempting with 4 users, but those fallbacks are themselves noise. Shrink to a single global fallback first.

## 4. Future evaluation protocol (pre-register before collecting)

1. **Instrument properly**: capture raw `active_ms` (nullable), keep `null` semantically distinct from `0`, and never silently impute nulls into training. Client-side focus/blur + heartbeat; submission timestamps only bound an interval — they do not measure engagement.
2. **Rolling/expanding-window backtests**: estimate at time *t* using only data < *t*; score against realized durations in (t, t+Δ]. **Everything fit inside the training window only** — quantiles, winsorization caps, fallback constant, and k. Refit per fold; a threshold fit on full history is leakage.
3. **Metrics**: pinball loss for quantiles, absolute error for point estimates, coverage of prediction intervals. Report pooled **and** per-user, given heterogeneity and the 4-user clustering problem. Use session-level paired comparisons (paired bootstrap) rather than attempt-level pseudo-replication.
4. **Decision rule in advance**, e.g.: "switch from fallback only if the estimator beats it by ≥X% with session-level paired significance." Without this, an afternoon of fold-tuning will manufacture a winner.
5. **Data hygiene**: reconcile the funnel — 2784 attempts → 1061 submissions → 410 graded — and log the *reason* for every missing `active_ms`/`grading_ms` so missingness is analyzable, not ambient.

## 5. Grading wait vs. effective study time

These must be separate pipelines and separate reports — never combined:

- **`grading_ms`** is platform latency (grading turnaround): largely system-determined, possibly queue-dependent, likely low-variance or bimodal. 410 samples may suffice for stable P50/P90 — check for bimodality before quoting a mean.
- **Active time** is user cognitive engagement: heavy-tailed, user-dependent, and currently **unmeasured**. Folding grading wait into "time spent studying" inflates engagement metrics and corrupts budget estimates.

## Bottom line

The production telemetry structurally cannot measure active time today; the metric is dead at the point of submission. Nothing in the current data can rank candidate estimators. Ship the pilot with the conservative estimator (fixed cap rather than empirical P90 recommended), treat the fallback and k = 20 as documented assumptions, and let a leakage-free rolling backtest on future instrumented data — with a pre-registered decision rule — make the choice. Until then, "not measurable" is the correct label for active study time.
