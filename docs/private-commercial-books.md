# Private sources for the five existing exam targets

Only `cet4`, `cet6`, `kaoyan`, `ielts`, `toefl` are selectable. Commercial IDs are internal provenance keys. The earlier commercial-book activation plan is superseded. Keep imported shared identities, source originals, batches, entitlements and quarantine intact.

Originals, source inventories, model logs, measured reports and prepared SQL belong in a restricted directory outside Git. A private-use assertion is separate from verified publisher authorization. Never send originals to external models without applicable processing authorization.

## Offline correction workflow

1. Capture read-only production membership/source/content/protected-table snapshots as `five-exam-snapshot.json`, and relevant installed function definitions as `five-exam-live-functions.json`. Recheck live Worker metadata and Git ancestry.
2. Reuse `normalized-draft.json`, existing source files and the pinned ECDICT CSV. Do not download or reimport commercial data for this correction.
3. Run `npx tsx scripts/dry-run-exam-source-mapping.ts <private-directory> <pinned-ecdict.csv>` to compute differences and prepare checksum-bound merge/rollback SQL. There is no network/database client.
4. Run `npx tsx scripts/replay-exam-source-mapping.ts <private-directory> <pinned-ecdict.csv>`. It loads accepted real local data and read-only memberships into PGlite, applies installed function definitions plus the corrective migration, and replays the merge twice. Learner fixtures are synthetic.
5. Prepare a code-only prompt with `scripts/review-exam-source-mapping.ts`, submit through current WorkBuddy MCP, retain full raw responses and structured findings outside Git. Save model JSON as `five-exam-workbuddy-model.json` and validate with `--validate`. Document engineering dispositions; model findings never automatically modify originals or identities.
6. Run typecheck, tests, build and a real-text build privacy scan. Browser QA uses synthetic fixtures only; it does not establish authenticated production or physical-device acceptance.

Original import tools remain for historical reproducibility, not for repeating production imports or restoring commercial learning targets.

## Membership and teaching

CET6 receives reviewed Xinghuo identities; IELTS receives reviewed Zhenjing and Wang Lu identities. CET4/Kaoyan require independent exact pinned ECDICT tags. TOEFL requires attributable evidence; do not relabel generic TOEFL files. Skip source records with no usable definition. Never clear or overwrite memberships.

Public membership rows contain normalized headwords and generic merge provenance only. Source-specific evidence stays in a restricted non-exposed admin audit table. ECDICT fields, personal glosses, notes, FSRS, BKT and frozen sessions are not updated by membership SQL.

Current-exam mappings select eligible commercial definitions. Source entitlements are independent of permanently unavailable internal catalog rows and expire on every source/frozen-session read. Service RPCs and source tables remain inaccessible to ordinary Data API roles. Unlicensed users get ECDICT fallback; source-only words are not allocated to them.

General IELTS word recall uses Zhenjing first and Wang Lu as fallback. Preserve alternative sources and original sense order; freeze one teaching source instead of flattening books. This is a source suitability policy, not independently established semantic quality or publisher fidelity. Originals never go to DeepSeek. Existing non-exam personal cards retain their own legacy glosses.

The Kaoyan private-owner scope is the union of existing personal entries and independently evidenced public Kaoyan members. Existing personal glosses and FSRS cards remain unchanged.

## Future release after explicit confirmation

No new production write or Worker deployment is authorized for this correction dry-run.

After confirmation: refresh drift checks; save restricted membership/catalog/function backups and protected-table digests; apply the corrective migration with source mappings disabled by default; deploy and verify the compatible Worker; only then execute reviewed merge SQL, atomically adding missing memberships and enabling the three supported mappings. Checksum prepared SQL and abort at the first error (`psql -v ON_ERROR_STOP=1` where applicable). Do not activate internal source catalog rows.

Verify licensed/unlicensed source reads, frozen retries, revocation, unchanged learner hashes and idempotence. Rollback disables mappings and removes only added membership rows still bearing the exact merge batch marker. Preserve source originals, shared identities and all learner history, including subsequent cards. Keep the five-target authorization-aware catalog during application rollback; never restore unfiltered source catalogs or old learner tables.
