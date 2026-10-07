# Family bilingual dictionary and consolidation repair

## Knowledge and source boundaries

`lexical_dictionary_entries` stores lemma-level bilingual dictionary material separately from OEWN sense/synset definitions and user learning state. Translations are not asserted to align with individual synsets. This import does not infer lexical relations, create learning cards, change FSRS scheduling, or rebuild the frozen Lesson queue.

Chinese and additional English glosses come from [ECDICT](https://github.com/skywind3000/ECDICT), revision `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`, licensed by its repository under MIT, Copyright (c) 2025 Linwei. The full notice is retained in `server/data/licenses/ECDICT-MIT.txt`. CSV SHA-256: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`.

Every entry retains the source, pinned revision, license, file checksum, original row numbers/surface/raw POS, attribution and editorial confidence. Case, surrounding/repeated whitespace and NFC are normalized; same-lemma source rows merge without losing evidence. CSV quoted commas/newlines and literal escaped newlines are handled. Only explicit dictionary POS labels are parsed; n/v/adj/adv and vt/vi distinctions remain available. Domain annotations stay as supplementary glosses. Missing Chinese remains explicitly unavailable or English-only.

OEWN 2025 remains the English semantic backbone, under CC BY 4.0 plus inherited Princeton notices. The parser now reads both paired and self-closing Sense elements. Previously omitted sense definitions are repaired without inferring new relations. Existing lexical IDs, family keys and scores remain unchanged. Additional current-vocabulary bases use real OEWN lemma/POS records; words without verified relatives display a center-only graph.

## Production import on 2026-10-07

- 23,268 dictionary entries, 23,261 with Chinese.
- Chinese available for 6,590 of 6,593 current vocabulary words.
- 26,785 lexical nodes, including 1,435 additional OEWN bases.
- 57,703 OEWN senses; zero stored lexemes without a sense.
- 28,760 lexical relations, unchanged by this dictionary import.

All 138 bounded batches verified that the requesting account's `user_words` and `study_sessions` contents stayed unchanged. The dictionary table has service-only RLS/grants and an indexed language/lemma query. Import files and private vocabulary reports remain ignored QA artifacts. Reproduce with:

```text
node --import tsx scripts/build-ecdict-corpus.ts PINNED_CSV GRAPH_CORPUS PRIVATE_VOCAB_JSON PRIVATE_OUTPUT_DIR
node --import tsx scripts/build-oewn-dictionary.ts OEWN_XML GRAPH_CORPUS PRIVATE_VOCAB_JSON PRIVATE_OUTPUT_DIR
```

## Lesson behavior

The node mini-card lazily fetches `/api/web/family/dictionary?lemma=...`, showing all available dictionary POS and Chinese glosses with source/license. Full source English entry text and bounded OEWN senses remain separately expandable. Ordinary graph requests still load only one hop.

On explicit micro-session start, only the base and selected derivative (or at most three existing Stage D members) load dictionary material. Generic practice prefers sourced Chinese for the relevant POS, uses OEWN examples where available, and falls back to definition recall. Stage A consolidates only the base, with no new card or FSRS review log. Existing B/C initialization and spacing remain canonical.

Startup failures now appear beside the button, a loading label confirms the request, and successful transitions scroll the short course into view. Missing-content errors describe missing definitions rather than repeating the candidate recommendation; daily budget rejection is preserved.

## Verification and limits

Typecheck and the full suite pass: 791 tests passed, two credential-dependent integration tests skipped. Regression coverage includes self-closing OEWN senses, CSV/POS normalization, duplicate source rows, provenance, strict authenticated dictionary API, idempotent knowledge-only SQL import, sourced-Chinese startup with no OEWN senses, missing-content explanation and budget rejection.

Actual local browser acceptance used the real Standalone Lesson UI, sourced `persecute` data and PostgreSQL RPCs: open Family, start current-word consolidation, answer both questions, reach completion. Card count stayed one, FSRS logs zero, frozen Lesson state unchanged. Layout checked at 390×844 and 820×1180; these are browser viewport checks, not physical iPhone/Safari acceptance.

ECDICT coverage is not complete; three current words still lack Chinese in this pinned source. Lemma-level glosses may contain dated vocabulary or domain notes and are not reviewed synset translations. When OEWN provides no usable example, practice falls back to definition recall. Network View, Global Graph and generated lexical facts remain outside this release.
