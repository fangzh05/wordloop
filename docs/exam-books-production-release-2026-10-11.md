# Public exam books production release — 2026-10-11

This report supersedes the unpublished/import status in the earlier implementation report. Published at 2026-10-11 10:30:37 UTC (18:30:37 Asia/Shanghai). All five exam_books rows are public and available.

| Book | Final public headwords |
|---|---:|
| kaoyan | 5528 |
| cet4 | 3846 |
| cet6 | 5406 |
| ielts | 5038 |
| toefl | 6973 |

Added 3,015 shared dictionary records and 26,791 unique membership relations. Existing 23,432 dictionary records compare exactly with the pre-import snapshot; final dictionary count 26,447. Every public membership has a shared English dictionary row with a nonempty Chinese translation. Membership storage including indexes measured 6,160,384 bytes after initial import (not a full database storage delta).

Public source/version/license and complete licensed membership files: [data/exam-books](data/exam-books/README.md). Membership-manifest commit: 2a53ecc. The production Worker code was already deployed from 40cd372; no runtime changes or Worker rebuild were required for this data-only publication.

Human owner explicitly confirmed noncommercial use and ShareAlike distribution of NETEM data and approved the proposed 28-item ECDICT disposition. ECDICT: 22 approved with separate normalized identities retained; six temporarily excluded (b.c., i.e., p.m., in spite of, drop-out, dropout). NETEM: two exact duplicate source rows collapsed. All 154 other-spelling annotations remain outside the main-headword release; no uncertain variant is automatically enrolled or merged.

WorkBuddy: original 28-item advisory review completed; source-search attempt 1 timed out, attempt 2 completed with three reported WebSearch calls; 154-item NETEM advisory review completed with 83 spelling_variant, 5 different_form, 66 needs_review. Record/word identity and complete coverage validated. All WorkBuddy tasks used deny permissions and no external write permissions. Actual underlying model was unverified (auto), not claimed as DeepSeek V4.1. Native Computer Use invocations: 0; WorkBuddy ACP connector used. Source-search and variant-review searches reported six total read-only web lookups.

Private owner union remains 7,048 words. Its overlap with independent public kaoyan is 5,461 words: 1,587 private-only, 67 public-only. Existing owner retains the private source union as their kaoyan learning scope; other users receive the independent 5,528-word public dataset. No private source rows or definitions were copied into public memberships.

## Production protection and verification

- Scoped in-database backup of dictionary, catalog and memberships created in non-public schema exam_release_backup_20261011 before import. Restore probe reproduced all 23,432 existing dictionary rows exactly. Anonymous and authenticated roles cannot access the backup schema. This is not a full-project offsite backup.
- words full-row MD5 before/after: 3c55c5b1ee9fc04d89cb64f6ccb91d70 (all existing IDs, senses and IPA preserved).
- lexical_relations full-row MD5 before/after: be91d49dd3a09048b4983c502d9aa77a.
- user_words ID MD5 before/after: 22d775ace5dddcd580f08d90283d7743; FSRS log count remained 1,745. Full learner-state/FSRS-row hashing was not performed in this release; the import only inserted dictionary and public membership rows and updated catalog metadata.
- RLS authenticated-role probe reads five public books and 26,791 memberships, zero preferences for an unrelated identity; no direct set RPC permission and no backup-schema access.
- Production transactional smoke used two temporary public.users records, then rolled back everything. Verified all five selections, explicit initial choice, no eager card creation, isolated preferences, two actual CET6 new-word allocations within budget, matching selected-book membership, repeated allocation idempotence, pinned daily allocation retained after changing target, and zero generated FSRS logs. Final probe confirmed zero test users remain.
- PGlite actual corpus import twice: 3,015 dictionary entries and 26,791 memberships both times; no missing Chinese glosses. Focused feature suite: 9 passed. The earlier runtime release passed typecheck, build and 880 tests (2 skipped).
- Live MCP smoke after publication: initialize succeeded, 33 tools, 16 resources, Lesson resource readable.

One oversized membership batch was truncated by the command-output transport and rejected by PostgreSQL before executing; import resumed with smaller batches using the same unique constraints. Final exact-count and coverage checks passed before atomic publication.

Remaining verification limits: authenticated browser interaction through Pretest/Lesson/grading/resume and physical iPhone/iPad Safari acceptance have not been completed. Database RPC learning smoke and local browser fixture evidence must not be described as full browser acceptance. Due-review scheduling was not altered by this data-only release.

Complete local audit: .exam-books/release (corpus, manifest, human decisions, baseline, backup verification, import verification, final verification, learning and RLS smoke); .exam-books/source-research (pinned source, license, deterministic cleaning, WorkBuddy raw prompt/output and candidate report); .exam-books/workbuddy-review (original 28-item advisory review). Nothing in these model outputs served as a substitute for the human ECDICT approval.

Rollback: hide catalog rows as documented in data/exam-books/README.md; retain enrolled cards and learner histories. Restore original catalog metadata from the private scoped backup if needed. Never remove dictionary additions already referenced by learning cards.
