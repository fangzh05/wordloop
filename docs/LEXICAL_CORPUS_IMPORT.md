# Local Family Graph corpus import

The reviewed 21-word fixture remains the test seed. Production coverage is expanded using OEWN 2025 and the pinned MorphyNet English derivational v1 database; attribution and data licenses are in `server/data/ATTRIBUTION.md`. No new dependencies or schema migration are required.

## Build and import

Download the official OEWN 2025 XML and MorphyNet file listed in the attribution notice. Provide a private JSON array of the authenticated account's current vocabulary. Do not commit that file or the coverage report. Run in a configured administrator environment:

```powershell
node --import tsx scripts/build-family-corpus.ts OEWN_XML MORPHYNET_TSV PRIVATE_VOCAB_JSON OUTPUT_JSON
node --import tsx scripts/import-family-seed.ts OUTPUT_JSON
```

For connector-based administration without local service credentials, `scripts/prepare-family-sql.ts OUTPUT_JSON OUTPUT_DIRECTORY` generates bounded SQL batches and a manifest with file checksums. The lexical-only SQL transport supports idempotent upserts and is exercised against real PostgreSQL semantics through PGlite. Apply batches in dependency order. Never load client files through server filesystem SQL, and never include credential or learner identifiers in generated data.

## Rules and boundaries

- NFC, whitespace normalization, lowercase and canonical `en:lemma:POS` identity; no duplicate nodes across sources.
- Only explicit OEWN derivation and explicit MorphyNet prefix/suffix derivation. Validate both lemma/POS entries against OEWN. Reject multiword usage, unsupported POS, self-links and ordinary inflections. No spelling/embedding clustering.
- OEWN reciprocal sense evidence becomes one undirected browsing edge. MorphyNet records retain forward direction and every original row. Existing reviewed records retain their IDs and editorial metadata.
- Select vocabulary roots and their immediate neighbors, then import adjacency around those neighbors to support deliberate expansion. Graph API still returns only one hop, at most 24 nodes; browser renders at most 40.
- Connected components of verified derivation edges provide spacing keys, preserving reviewed seed family keys. Components do not create learning cards or alter existing queues.
- New source entries have unknown frequency bands and neutral utility/exam defaults. Confidence is an editorial threshold, not a measured probability. Recommendation requires a forward edge, a stable base, suitable utility/transparency and existing family interference/spacing guards.
- Generic micro-sessions use OEWN sense definitions and matching source examples. Definitions/contexts blank the target form. Without a source example, use definition recall. Never fabricate example sentences or attach an example from a different sense.
- All writes target existing lexical tables. Learner state, FSRS state, events and frozen sessions remain in their canonical models.

The scoped build contained 25,350 lexemes, 34,572 senses, 25,350 lemma forms, and 28,760 sourced relations. Coverage is measured separately against the private vocabulary; an absent verified derivation remains an honest empty state. Some words have no morphological family, and many upstream records are excluded by POS/form validation. Network View, Kaikki enrichment, global graph and automated AI relation generation remain out of scope.
