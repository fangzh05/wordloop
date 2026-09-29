# WordLoop Insights Metrics and Capture Migration

Version: `wordloop-analytics-v1`

Business time zone: the authenticated user's configured IANA time zone (currently verified as `Asia/Shanghai`).
All read models take one server-generated `as_of` timestamp per request and return it with the time zone and coverage metadata.

## Metric dictionary

| Metric | Definition | Source and limits |
| --- | --- | --- |
| Formal Review today | Completed and remaining cards in the current active Review snapshot, or the sum of already recorded Review batches for today's study sessions when no Review session is active. | Existing server snapshot semantics. `scope` is `active_session` or `today_recorded_sessions`. Lesson re-learning is separate. It is not a count of every card that could become due today. |
| Pretest complete | Words whose current status is no longer `new`, using the existing progress snapshot. | This is prediction-test state, not formal learning completion or mastery. |
| Formal Lesson words | Distinct words in the verified same-day completed Lesson set; the response separates new words and re-learning words. | Derived from the existing completion helper and server-owned session snapshots. Pretest and ordinary attempts do not count. |
| Long-term first-recall success rate | For each word and local natural date, take its first formal `review` log before applying eligibility. Include only `scheduled_days >= 1` and ratings 1–4. Ratings Again (1) fail; Hard/Good/Easy (2–4) pass. | `fsrs_review_logs`; excludes pretest and session checkpoints. Invalid ratings and first reviews below a one-day scheduled interval are reported separately. The ratio is total passes / total eligible samples, never the mean of daily percentages. Trends use rolling 7- and 30-day numerator/denominator totals. Today's point is partial through `as_of`. |
| Current memory set | User words with `fsrs_reps > 0`. | Current snapshot, independent of the selected historical range. No unscheduled word contributes to S or D means. |
| Stability S | Mean, median, and histogram of finite, positive `fsrs_stability` values in the current memory set. | FSRS card state. Invalid/non-positive stability or invalid D is counted in `excluded_count`; an empty valid set returns `null`, not zero. |
| Difficulty D | Mean, median, and histogram of finite values in the FSRS domain 1–10. | Current snapshot. D is not an error rate or a diagnosis. |
| Retrievability R | `createFsrsScheduler().get_retrievability(cardFromUserWord(row), as_of, false)` for cards with a last review and valid positive S. | Model estimate from the current FSRS configuration; no scheduling call is made. Missing or invalid R stays null and is not plotted as 0. R below the 0.90 configured target is a review-priority reason, not proof that the learner forgot. |
| Due distribution | Mutually exclusive previous-day overdue, due earlier today, due later today, and next due date buckets for the following 1–30 local dates. | Only each card's currently scheduled `next_review_at` is counted. This is a snapshot, not a workload forecast; future buckets exclude overdue and today's cards. |
| Active error words | Distinct current `user_words` rows with one or more active error flags, plus per-layer flag counts. | Current state, separate from historical error attempts. A word may have several active flags. |
| Historical error matrix | Wrong `attempts` grouped by activity type and one recorded error layer; counts events and distinct words. | Selected 7/30/90 local-date window. `none`, null, and unknown layers are `unclassified`. The optional per-100 value is `error_events / all attempts of that activity_type * 100`; it is a label frequency, not a skill accuracy score. |
| Formal Review activity | Number of `fsrs_review_logs` rows with `review_source='review'`, plus distinct words. | Kept separate from pretest logs and ordinary `attempts`; do not add these series into a single event total. |
| First introductions | Each word's earliest pretest log in the selected window. | Labels first entry into the formal queue, not mastery or Lesson completion. |
| Capture activity | Count of canonical `captured_note_occurrences`. | A repeated encounter is a capture occurrence. No focus duration or fabricated completion event is shown. |
| First formal Lesson completion | Unavailable. | Existing historical records do not establish this event reliably; the API reports the series as unavailable. |

## Capture storage and rollback

`captured_notes` and `captured_note_occurrences` are the sole authoritative Capture store. The old `capture_notes` tables remain intact for audit and rollback evidence. `capture_note_legacy_map` preserves legacy IDs, text, status, counts, timestamps, and legacy `words.id` links. A linked legacy `word_id` is converted only after resolving `(user_id, word_id)` to the owner's `user_words.id`.

The migration copies parent notes idempotently by `(user_id, normalized_text)` and copies each occurrence with its original occurrence ID as the idempotency key. It refuses unresolved legacy `learning` links. It preserves a previously archived status even if a word link exists. Historical fields wider than the current write contract are preserved by widening the relevant canonical storage check to the largest existing legacy value; new API writes remain bounded and are rejected rather than truncated.

The application adapter reads and writes only canonical RPCs. Capture creation uses one UUID idempotency key for one intent. Promotion takes the note row lock, then serializes new daily-import positions through the `(user_id, import_date, source)` import row. Existing user words are linked without resetting status or FSRS state and are reported as connected rather than scheduled today.

Rollback is forward-compatible and non-destructive: keep the canonical tables, legacy map, RPCs, and at least one application version whose Capture routes read canonical storage. Revert UI/API changes only to a known canonical-adapter build. Do not roll back to a legacy-only writer, drop canonical tables, or introduce dual writes; any emergency legacy-only rollback must first provide a read bridge so new canonical captures remain accessible.

## Validation and deployment notes

These definitions are versioned in code as `wordloop-analytics-v1`. Production values are never embedded in the interface. The migrations in this branch have not been applied to production, and this change has not been deployed. A production migration run must first repeat the read-only row-count, link-resolution, index, and `EXPLAIN` audit; apply only through the normal release workflow and recheck counts and sampled mappings afterward.
