# Learning time telemetry repair, 2026-10-15

Production browser requests used Neon timestamps ending in `+00:00`.
The strict observation schema accepted only `Z`, so checkpoints received HTTP 400
before reaching the recorder. The consolidation context could additionally leak
`consolidation_status` into the strict wire schema.

The repair accepts ISO timestamps with explicit offsets and removes the UI-only
consolidation status from observation payloads. SQL authorization, duration bounds,
learning outcomes and daily budgets are unchanged. Historical submission gaps are
not reconstructed as active learning time.

Validation: typecheck, build, deploy dry-run and 109 relevant tests passed, including
offset timestamp validation through SQL checkpoint and finalized daily aggregation.
The complete suite had 975 passes, 5 failures and 25 skipped tests, with four failing
suites. Re-running those suites on unchanged parent b653e1a reproduced all failures:
analyticsToday, performancePaths and progressRuntime still assert superseded review
progress behavior; familyDatabase has an allocator migration fixture mismatch.

Production Worker `wordloop-app` version `ed0393ff-8b6c-410b-9445-acf1cfcd0698`
was deployed from a1c86f9. Rollback baseline:
`2c75902f-b83c-4591-9321-961673bd9cea`.
Both domains returned 200 for root, health, auth config, app.js and styles.css.
MCP initialized and listed 33 tools and 16 resources.

Authenticated browser checkpoints returned HTTP 200 and `recorded: true`.
Read-only Neon main verification confirmed observations changed from zero to one;
the checkpoint remained unfinalized, and daily/lifecycle summaries remained zero.
No answer was submitted during verification. Completed sample aggregation is covered
by the database regression test; a real completed learner sample and physical device
validation are not claimed.
