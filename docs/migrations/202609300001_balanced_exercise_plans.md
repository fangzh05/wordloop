# 202609300001 — balanced exercise plans

This additive migration stores immutable plan-bound submission events and skill evidence separately from FSRS state, plus one per-user durable consolidation cadence record. `record_planned_submission_v1` serializes session revision checks, attempt/evidence writes, distinct-word daily credits, pending-task creation, and consolidation cursor advancement in one database transaction. The RPC is service-role only; the new event/cadence tables have RLS enabled and no end-user grants. Existing FSRS columns and review RPCs are not changed.

Apply `supabase/migrations/202609300001_balanced_exercise_plans.sql` after the prior migrations. `setup.sql` carries the same migration at its marked tail for fresh database setup. Do not apply both as independent migration runs; each SQL block is idempotent where possible, but the normal migration ledger remains authoritative.

Existing Review and Pretest activity labels can be scoped deterministically. Historical `translation_en_to_cn` and `sentence` attempts are ambiguous because older code used those labels for both round-end tasks and other exercises; the migration records them as `legacy` rather than guessing their scope. New Review/Pretest rows are normalized by an activity-family trigger; planned Lesson and consolidation writes carry their explicit scope in the atomic submission RPC. No historical completion credits or pending tasks are backfilled: first release starts at zero credit and rotation cursor zero.

## Rollback

For an application-only rollback, redeploy/revert to code that does not call `record_planned_submission_v1`; additive columns and tables may remain safely in place. Preserve the event/evidence/cadence rows for audit and future adapter re-estimation. Only drop the RPC and tables in a separately reviewed maintenance migration after confirming no deployed client/server can call them and exporting any evidence needed for future analysis. Do not reset FSRS data or rewrite historical attempts as part of rollback.
