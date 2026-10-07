# Local Family Graph v1 data attribution

This directory contains a small, reviewed adaptation of **Open English WordNet 2025**, created by the Open English WordNet team, incorporating **Princeton University WordNet**. Official source: https://en-word.net/static/english-wordnet-2025.xml.gz. OEWN is licensed under **CC BY 4.0**, with the original WordNet license applying to inherited data. Both notices are retained in `licenses/OEWN-LICENSE.md` and `licenses/WNDB_License.txt`.

Changes made by WordLoop: selected 21 canonical English lexemes, retained up to two source senses per lexeme, normalized IDs and relations, oriented individually reviewed morphology, and added original Chinese teaching notes. Each extracted sense/form/relation retains its source, edition, URL and XML SHA-256. Relation provenance also retains original sense IDs and raw relation types. The scores for utility, exam relevance, transparency, interference and confidence are editorial v1 estimates; OEWN does not supply these scores. Frequency bands are unknown (`null`).

Four additional morphology records are adapted from the English Wiktionary contributors under **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/). The adapted Wiktionary records remain available under that license. Permanent source revisions preserve attribution/history links:

- reconcilable: https://en.wiktionary.org/w/index.php?title=reconcilable&oldid=91698837
- active: https://en.wiktionary.org/w/index.php?title=active&oldid=92768449
- activate: https://en.wiktionary.org/w/index.php?title=activate&oldid=92355748
- economical: https://en.wiktionary.org/w/index.php?title=economical&oldid=92744007

WordLoop records the source and revision of each Wiktionary adaptation individually and marks the normalization as reviewed. These records are not asserted to be OEWN derivation records. In particular, `act → active` is a modern surface morphology analysis, not a claim about direct historical derivation in English. Kaikki is reserved for future enrichment; no Kaikki records have been imported.

Copyright (c) 2016–2025, The Cytoscape Consortium. The graph engine uses Cytoscape.js 3.33.1 under the MIT License. Its full notice is retained in `licenses/Cytoscape-MIT.txt` and included in the generated `family.js` bundle.

## Vocabulary-scoped corpus import

The bulk importer also adapts the official **MorphyNet English derivational v1** database by **Khuyagbaatar Batsuren, Gábor Bella and Fausto Giunchiglia**, derived from Wiktionary. Source: https://github.com/kbatsuren/MorphyNet, revision `378144f64df58c78db5245af19d16a511ccecf3a`, file `eng/eng.derivational.v1.tsv`. License: **CC BY-SA 3.0** (https://creativecommons.org/licenses/by-sa/3.0/). The imported MorphyNet adaptations remain under CC BY-SA 3.0; this data license is separate from application code and OEWN data licensing. See `licenses/MorphyNet-CC-BY-SA-3.0.md`.

WordLoop changes: canonical lemma/POS IDs, OEWN lemma/POS validation, removal of unsupported multiword records and ordinary inflections, directional deduplication and selection around the current vocabulary. Each relation retains the upstream file URL, pinned revision, file SHA-256, original TSV fields and row number, author attribution, Wiktionary entry link and adaptation notice. OEWN relations retain the original sense IDs and XML checksum. Only OEWN's explicit `derivation` relation is mapped; `pertainym` is not mapped to DERIVATION.

Corpus confidence/transparency/interference and neutral utility/exam values are deterministic editorial defaults, not calibrated probabilities, measured frequency or personalized mastery. OEWN-only edges are undirected for browsing. First-derivative recommendations require a verified forward edge. Chinese lessons in the reviewed seed remain original; other short lessons use attributed dictionary definitions and OEWN source example sentences, with definition recall when no suitable source example exists. No LLM-generated relation is persisted.

## Bilingual dictionary enrichment

Chinese and additional English word-level definitions are adapted from **ECDICT**, https://github.com/skywind3000/ECDICT, pinned revision `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`. Repository license: **MIT**, Copyright (c) 2025 Linwei. Full notice: `licenses/ECDICT-MIT.txt`. CSV SHA-256: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`.

Adaptations: vocabulary-scoped selection, lemma normalization, source-row merging, explicit POS-label parsing and escaped-line normalization. Each entry retains original row numbers, surface forms, raw POS, file checksum, source/revision/license and attribution. These are lemma-level bilingual glosses, not claimed translations of OEWN synsets. The enrichment creates no lexical relations or learning state. OEWN import also retains all available Sense elements, including self-closing XML records, under its existing notices.
