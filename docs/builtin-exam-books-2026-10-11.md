# Built-in exam books implementation and release status

Status: local implementation, NOT a completed production release. 2026-10-11.

## Git and deployment audit

- Branch: `codex/builtin-exam-books`, isolated worktree `C:/Users/16648/.codex/worktrees/builtin-exam-books`.
- Fetched baseline: `origin/feat/cloudflare-workers-production`, `e48f4a374dab868d971e4cac75bf1532e5613113`. Refetched before handoff; unchanged.
- Original checkout and existing production worktree were dirty. Neither was modified.
- Cloudflare deployment inventory contains baseline version `3d3682f2-e206-4607-a907-d13af9c29555` and later deployment `3af2ac4e-d8b9-4b31-a1a9-e60c29064bc5` at 08:57:34 UTC. Deployment annotations indicate additional work after the fetched baseline. Do not overwrite that production bundle without reconciling its source.
- Supabase project verified against wrangler config: `jgzzrlnmakllhurjiazh`.
- No production schema migration, data import, book publication, frontend/backend deployment, Git push or PR was performed.

## Source and dry run

The supplied ECDICT revision omitted its final `b`. Live dictionary provenance and the existing source builder agree on full revision `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`.

Full `ecdict.csv` downloaded and checked against SHA-256 `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`. License fetched from the same revision: MIT, Copyright (c) 2025 Linwei. Existing attribution is retained in `server/data/licenses/ECDICT-MIT.txt`. No mini CSV or ky tag is used.

| Book | Raw tag rows | Normalized unique | Existing dictionary | Missing before review | Draft accepted membership |
|---|---:|---:|---:|---:|---:|
| CET-4 | 3849 | 3849 | 3724 | 125 | 3841 |
| CET-6 | 5407 | 5407 | 4932 | 475 | 5401 |
| IELTS | 5040 | 5040 | 4005 | 1035 | 5029 |
| TOEFL | 6974 | 6974 | 4889 | 2085 | 6960 |

Unique union: 10578; existing dictionary union: 7571; missing union before review: 3007. Draft missing dictionary additions after withholding review candidates: 2988. Actual production additions: **0**. Draft counts are not final published book counts.

Exact-normalization duplicate rows: 0. Pending review candidates: 28. Human approved/rejected: 0/0. No candidate was silently discarded. Invalid formats, multiword entries and folded spelling collisions are preserved in audit files. Current WordLoop identity normalization remains trim/lowercase; Unicode compatibility, apostrophe, hyphen and whitespace folding is a candidate hint only, never a silent identity merge.

Inclusive intersections (members belong to at least these books):

| Tags | Count |
|---|---:|
| cet4 & cet6 | 3451 |
| cet4 & ielts | 2146 |
| cet4 & toefl | 2177 |
| cet6 & ielts | 3042 |
| cet6 & toefl | 3239 |
| ielts & toefl | 2911 |
| cet4 & cet6 & ielts | 1981 |
| cet4 & cet6 & toefl | 2040 |
| cet4 & ielts & toefl | 1446 |
| cet6 & ielts & toefl | 2187 |
| all four | 1380 |

Serialized draft payload: 7,016,205 bytes. Actual PostgreSQL heap/TOAST/index storage increase has not been measured; this requires an isolated import and cannot be inferred accurately from JSON size.

## Kaoyan authorization and isolation

Live read-only counts: `ougkp` 6593, `athgc` 1200, intersection 745, unique union 7048. Each source belongs to one owner. No public redistribution authorization was found or supplied. Ownership is not redistribution permission.

The private owner retains a dynamic, user-filtered union of existing word_sources; no source record, word ID, senses or learning state is copied or replaced. Other users see no private membership or progress. Public kaoyan has no dataset and remains unavailable. No independent public kaoyan dataset was fabricated or replaced with ECDICT ky. Public/private dataset differences cannot be enumerated until an authorized public dataset is supplied.

All five production publication states: **not published by this feature**, publication time unset. The migration seeds all five as unpublished/unavailable. The four ECDICT books carry MIT provenance; public kaoyan source/version/license remain pending. Owner-only private kaoyan access is distinct from public publication.

## Database and backend

Additive tables: exam_books, exam_book_words, user_book_preferences, daily_book_targets. Public membership primary key is `(book_id, normalized_word)`; existing global word and user-word uniqueness remain authoritative. No dictionary definitions are copied into membership rows.

Book preference mutation is service-role-only, uses the authenticated request identity and database timezone, and is serialized with the existing allocator advisory lock. Selection takes effect tomorrow. Daily targets are pinned; existing tasks and study sessions are never rebuilt. Existing private-owner default is kaoyan; other users must choose explicitly.

The migration captures and clones the LIVE allocator instead of replaying a stale checked-in budget implementation. It requires exactly one recognized insertion marker and candidate filter marker and aborts on drift. Only the missing-pool materialization hook and book predicate are added; original live function is retained for rollback. This matters because the live budget differs from the checked-in migration.

New cards are created only up to remaining allocation capacity, with `ON CONFLICT DO NOTHING`. Existing words.senses and IPA are never updated. Public-book cards reuse the shared dictionary service rather than exposing global commercial senses belonging to the original owner. Pure conversion fails closed to empty gloss/IPA until shared dictionary hydration. Existing owner cards retain existing senses.

Authenticated API: GET `/api/web/exam-books`, PUT `/api/web/exam-books/selection`, GET `/api/web/exam-books/:id/words` (bounded keyset pagination). No caller-supplied user ID is accepted. Personal responses retain the existing no-store request/response behavior; no cross-user cache was added. Public list membership has no private source joins. Catalog statistics use SQL aggregation scoped to the current identity.

RLS: published public catalog/memberships are read-only for authenticated users; private preferences select only auth.uid(). Preference writes go through the verified backend RPC; daily target rows and RPCs are inaccessible to anon/authenticated roles. This is verified locally, not asserted as live production RLS acceptance.

Offline SQL generation is gated on a final manifest with zero unresolved reviews and matching hashes for every audit file. Inserts only missing dictionary lemmas and memberships, never calls import_vocabulary_batch_v1, never publishes automatically. A negative test of the current dry run correctly refuses to generate import SQL. No final manifest exists yet. Production execution still requires a verified restorable backup and fresh database difference report.

Rollback restores the captured live allocator and hides books while retaining enrolled cards, preferences, dictionary entries and learning history. Local rollback tested successfully.

## Product Design and UI acceptance

Plugin version: Product Design 0.1.56. Loaded index, user-context/preflight, audit, get-context, image-to-code, design-qa and critical overrides. No saved product context existed. Existing code is the explicit visual target; no new design alternatives/framework/template initialization were needed or introduced. User's production implementation scope takes priority over the skill's generic prototype scaffolding guidance.

Steps: identify Today/Vocabulary task; inspect current components/styles/tokens/settings sheet; capture existing components locally; choose compact incremental information architecture; implement shared provider and selector; exercise save/update; capture desktop/mobile/tablet and light/dark states; compare before/after montages. Reused fonts, colors, borders, buttons, radii and dialog convention. Native modal dialog provides focus isolation, Escape and return focus; save is explicit, unavailable rows disabled with reason; safe-area/dvh styles added. No navigation tab added.

1. Today entry: main learning card/button retains its position, new secondary entry below it. Local visual pass.
2. Vocabulary entry: compact row below title, existing import/search/filter components retained. Local visual pass; full real-data search/detail regression not browser-verified.
3. Selector: five compact rows, availability reasons, public scope and own-progress labels, explicit save. Local interaction pass.
4. Save CET-6: both Today and Vocabulary show the shared selection. Mock-API interaction pass, not production persistence proof.
5. 390×844 mobile: scrollable content and bottom save reachable, no horizontal overflow. Chromium pass, not Safari hardware acceptance.
6. 820×1180 tablet/light and desktop/dark: dialog layout and text readable, no horizontal overflow. Chromium pass.

Evidence directory: `.qa/exam-books/`: 01-today-before.png, 02-vocabulary-before.png, 03-today-after.png, 04-selector-desktop.png, 05-vocabulary-after.png, 06-selector-mobile.png, 07-selector-mobile-bottom.png, 08-selector-mobile-light.png, 09-selector-tablet-light.png; today-comparison.png and vocabulary-comparison.png combine before/after in one input.

Limits: production UI was behind login; screenshots are existing components rendered in a local fixture, with fixture data explicitly labeled. Today baseline/after use the same unavailable overview state. Vocabulary baseline lacked a fixture token and showed an error; after used an authenticated mock response and empty list, so the list-state difference is not attributed to the UI change. These are not full authenticated-product or Safari design acceptance evidence. Native iPhone/iPad Safari, VoiceOver, real account persistence and end-to-end learning remain pending.

## Verification and data protection

- Full suite before the final extra rollback test: **871 passed, 2 skipped**, 104 test files passed. The two existing Supabase integration tests were skipped.
- Final focused suite: **9 passed**, including source parsing/review replay, real PGlite allocation/RLS/rollback and public-card commercial-gloss isolation.
- TypeScript typecheck and production Worker/web build passed; git diff whitespace check passed.
- Production private words snapshot: count 7048, SHA-256 `9a299b6b2e4a73e56f756aceefdf0954bdcbfbc54c106a4478efa52e5a3449dd`, identical before/after. This hashes all word columns including IDs, senses and IPA.
- Production lexical_relations: count 29088, SHA-256 `f2eac1ee2b99c84bf7d0f2e7cafac99552ab56574fa14a0906234d097e4dbd8a`, identical before/after.
- user_words count 7048 at both reads; full row hash changed from `e35caca5ce58c30a07b1f72bf958d45e7af1171bd4e6f4a9e235d0ad1123ec30` to `dcf5729daf27a1a2ce9bd3378db2e223e35d103456a56202f4cd27a454d83a9f`.
- FSRS logs increased 1736→1739 during the audit; full hash changed. Production was active. This run only issued read-only SQL and cannot claim byte-for-byte unchanged production learner state or attribute concurrent changes to a particular actor.
- Local fixtures verify due-card FSRS fields and active session JSON remain unchanged during selection/allocation and rollback. Live BKT, all logs and actual learning-flow acceptance were not fully verified.

## Audit artifacts, model and reproduction

Local ignored directory `.exam-books/` contains the full pinned CSV, license, public existing-lemma snapshot and `dry-run/` report.json, manifest.json, draft-corpus.json, dedupe-candidates.jsonl, dedupe-model-review.jsonl, dedupe-human-review.csv, dedupe-approved.jsonl, dedupe-rejected.jsonl, human-decisions.json, dedupe-report.md. Source CSV record numbers include the header as record 1; quoted multiline fields remain one CSV record.

Rules version `exam-dedupe-v1`. Native application automation is disabled in this session, so WorkBuddy/DeepSeek V4.1 calls: **0**, candidate judgments: **0**, same_entry/different_entry/model-needs_review: **0/0/0**. Model/prompt version: not applicable, no invocation. The deterministic fallback produced 28 human-review candidates. No model output can become an import approval. No private commercial vocabulary or credentials were sent to a model.

Reproduce:

```powershell
node --import tsx scripts/build-exam-books.ts .exam-books/ecdict.csv .exam-books/existing-lemmas.json .exam-books/dry-run
# Human fills CSV action/reviewer/reason. Use a NEW output directory to preserve audit history.
node --import tsx scripts/build-exam-books.ts .exam-books/ecdict.csv .exam-books/existing-lemmas.json .exam-books/reviewed .exam-books/dry-run/dedupe-human-review.csv
# Only succeeds with zero unresolved review/gloss failures and valid audit hashes.
node --import tsx scripts/prepare-exam-import.ts .exam-books/reviewed .exam-books/import-reviewed.sql
```

Human approvals are bound to source checksum, rule version and candidate key. An invalid WordLoop format cannot be approved into the current learning schema. Model review files are advisory only; no model-dependent production runtime exists.

## Release blockers

28 human decisions; authorized public kaoyan dataset; reviewed final five-book manifests; actual storage measurement; verified restorable production backup; deployment-source reconciliation; isolated production-shaped import replay/difference check; authenticated multi-user public access/privacy validation; complete real learning/pretest/lesson/review/resume acceptance; Safari hardware acceptance. Therefore the five-public-book final acceptance standard is **not met**.

## Changed files

`.gitignore`; `scripts/build-exam-books.ts`; `scripts/lib/examBooks.ts`; `scripts/prepare-exam-import.ts`; `scripts/qa/examBooksHarness.tsx`; `scripts/qa/serveExamBooks.ts`; `server/services/examBooks.ts`; `server/services/examCardDictionary.ts`; `server/services/words.ts`; `server/services/review.ts`; `server/services/vocabulary.ts`; `server/webApi.ts`; `supabase/migrations/20261011092451_builtin_exam_books.sql`; `supabase/rollback/builtin_exam_books.sql`; `web/src/standalone/components/ExamBookSelector.tsx`; `web/src/standalone/StandaloneApp.tsx`; `web/src/standalone/pages/TodayPage.tsx`; `web/src/standalone/pages/VocabularyPage.tsx`; `web/src/styles.css`; `tests/examBooks.test.ts`; `tests/examBooksDatabase.test.ts`; `tests/examCardPrivacy.test.ts`; this report; design-qa.md.
