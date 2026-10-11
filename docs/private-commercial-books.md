# Private exam-book source import

The importer extends shared `words.normalized_word` identities with private source definitions. It does not replace ECDICT, existing personal senses, FSRS, BKT or study sessions. Missing or unverified book attribution is not fabricated.

Commercial source files, parsed originals, provenance inventories, model audit logs, import SQL and measured acceptance reports belong in an existing restricted directory **outside every Git checkout**. Do not commit these artifacts or copy them into Worker assets. Repository availability and a user's private learning assertion are separate from publisher authorization; preserve both facts without claiming verified publisher rights.

## Offline workflow

1. Create a restricted private processing directory outside the checkout. Python parsing requires `openpyxl==3.1.5`.
2. `python scripts/download-commercial-sources.py <private-directory>` downloads pinned source files and inventories repository trees. Full source clones can additionally be inspected at the pinned commits.
3. `python scripts/parse-commercial-sources.py <private-directory>` preserves raw XLSX cells, coordinates, merged cells, original text, chapter/group structure and resource-only materials. Static TS/JS literals use the non-executing parser in `scripts/parse-static-data.ts`.
4. `npx tsx scripts/audit-commercial-books.ts <private-directory> --review` normalizes exact identities and submits headword-only uncertainties through the configured WorkBuddy ACP adapter. Set `WORKBUDDY_PYTHON` to the installed bridge interpreter. Commercial definitions and learner data must not be sent to an external model without separate processing authorization.
5. Save a read-only identity/membership snapshot from the explicitly selected target environment. `npx tsx scripts/replay-commercial-books.ts <private-directory>` imports the real accepted corpus twice into an ephemeral PGlite database and verifies protected identities and learner-state isolation.
6. Obtain independent WorkBuddy database, import and runtime reviews. Save complete raw results outside Git, validate structured outcomes with Zod, and retain findings/dispositions rather than silently rewriting source text.
7. `scripts/validate-commercial-release-review.ts` validates reviewed outcomes and binds the code hashes. A trusted local release gate must pin the review, successful replay, read-only baseline and normalized draft, record the user's private-use assertion, and explicitly authorize production writes. `scripts/prepare-commercial-release.ts` only prepares checksum-bound SQL; it makes no network/database calls.

## Production boundary

Production import requires an explicitly confirmed target and authorization. Back up the affected identity/catalog/membership tables and original RPC definitions in a non-exposed, access-restricted schema. Capture protected learning/dictionary/relation integrity digests before writing. Apply the migration through Supabase migrations, keep private books unavailable while importing, verify every batch count and content/original-text hash, and replay idempotently before considering activation.

Entitlements are service-managed, expire explicitly, and do not assert publisher authorization. Ordinary roles have no direct source-table reads or service-RPC execution. The shared `words` table must remain protected by its existing RLS. Source intake is in a non-exposed admin schema and is not an end-user API.

The current authorized book controls the teaching source. Private plans use deterministic word recall and freeze their word, sense and source keys; no original text is sent to DeepSeek. Public ECDICT fallback and prior personal senses remain separate. A new private book cannot become public; missing-source placeholders cannot become available.

Deployment authorization is separate from database authorization. Deploy and verify the compatible Worker before enabling any new private catalog rows. Never activate source-missing books or grant access to unrelated accounts. Do not publish private source-derived comprehensive membership candidates without reviewing the permitted publication scope.

## Rollback

Run `supabase/rollback/private_commercial_books.sql` in the explicitly approved target to disable the private books while preserving source rows and all learner history. Keep the authorization-aware list RPC during an application rollback: restoring the old unfiltered catalog can expose private existence. Do not delete shared identities or restore learner tables over subsequent legitimate learning.

Run `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run build`, the real-corpus replay and environment-specific database checks. Browser QA uses synthetic fixtures (`scripts/qa/`), never raw commercial text. Local browser dimensions do not establish physical-device or authenticated production acceptance.
