# 20260930043648 — exercise plan foreign-key indexes

The initial exercise-plan deployment triggered five Supabase advisor findings for unindexed foreign keys on planned submission, per-skill evidence, and lesson credit rows. This additive migration adds one-column indexes for those foreign keys. It changes no row data, learning state, scoring, cadence, or FSRS fields.

The connected WordLoop Supabase project recorded this migration as version `20260930043648` (`exercise_plan_fk_indexes`). Keep that version in the filename so future CLI migration checks do not replay it. The same SQL is appended to `setup.sql` for fresh installs. The migration is safe to rerun because each index uses `if not exists`.

## Rollback

The indexes can be dropped in a separately reviewed maintenance migration if query and delete performance measurements show they are unnecessary. Keep the tables and their evidence rows; dropping indexes does not change attempt or FSRS behavior.
