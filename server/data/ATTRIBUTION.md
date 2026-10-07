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
