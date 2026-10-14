# IELTS / TOEFL source expansion

This release only expands existing `ielts` and `toefl` memberships. Commercial
IDs remain internal, unpublished sources. There are still five learning targets.

Run all tools with an existing restricted directory **outside every checkout**.
Do not put raw files, staged JSON, review logs or generated SQL in Git or assets.

```powershell
python scripts/download-ielts-toefl-sources.py <private-directory>
python scripts/parse-ielts-toefl-sources.py <private-directory>
node --import tsx scripts/prepare-deep-exam-import.ts <private-directory>
node --import tsx scripts/review-deep-exam-codebuddy.ts <private-directory> <installed-codebuddy-entrypoint>
node --import tsx scripts/replay-deep-exam-import.ts <private-directory>
python scripts/report-deep-exam-import.py <private-directory>
```

The parser additionally expects the previously pinned `English` clone and prior
private import/snapshot artifacts in the parent directory. The read-only snapshot
must separately contain shared identities, ECDICT coverage and exam memberships;
user enrollment counts must never be inferred from membership counts.

Downloads pin commit SHA and file SHA-256. JSONL preserves physical line identity;
SQL exports join actual primary/foreign keys. Worksheets retain original cells,
row numbers and continuation issues. Original definitions, English definitions,
POS, phonetics, phrases, versions and raw source structures are stored privately;
audio remains URL/metadata only. Missing chapters are not invented.

New candidates require valid syntax/POS and ECDICT evidence or separate source
families. KyleBing's repositories count as one lineage; the large inherited
TOEFL export is held, even if a caller omits its derived flag. Already reviewed
production Wang Lu/Zhenjing rows are explicitly reused, without reimporting or
promoting the previous 85 held records. Inflections/derivatives are never merged.

CodeBuddy CLI receives code and bounded headword-only samples. Tools and MCP are
disabled. Structured output is Zod-validated, cached and retried. Review suggestions
never change the plan automatically. All unsampled or unresolved records stay held.

`replay-deep-exam-import.ts` uses isolated PGlite, the real staged corpus and
read-only production snapshots. It imports twice, checks exact membership totals,
unchanged old identities/definitions/learner state, and actual new-member enrollment.
It uses parameter-bound admin intake and a transaction per source. It has no
production connection or deploy capability. Test entitlements prove access-control
behavior; they are not publisher authorization.

## Release boundary

The migrations add internal source metadata and retain source-level RLS/service
authorization. They do not import payloads, create entitlements or enable sources.
`merge.sql` has baseline/ownership checks and touches only IELTS/TOEFL membership;
source activation is a separate approval step. Ordinary users cannot query or
bulk-export source tables, and anonymous catalog requests cannot see internal IDs.

No original commercial text may replace ECDICT/public `words` fields. Original
publisher wording and redistribution rights remain unverified unless separately
documented. Repository licenses alone do not license third-party book contents.

Before any approved release: refresh snapshots, review source rights and grants,
back up new identity/source/member batches separately, apply the two pending
source-mapping migrations, deploy the compatible server, verify access and only
then import approved private sources and memberships. Do not run the earlier
five-exam merge: this release changes only IELTS and TOEFL.

Rollback removes only memberships still owned by this batch, disables only newly
enabled mappings, restores the prior Worker, and preserves source records, shared
identities and all learner history. A test pass or local commit is not a production
expansion. Detailed measured results and rollback SQL stay in the private report.
