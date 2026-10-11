# WordLoop public exam book data

The JSON files contain public normalized headword memberships and source record numbers only. They contain no private word_sources references, personal definitions, or learner data.

## Kaoyan

Source: the union of the WordLoop owner's existing Hongbaoshu (6,593 source entries) and familiar-word/less-common-meanings (1,200 source entries), 745 shared entries, 7,048 unique normalized headwords. The source data remains in the owner's private account. WordLoop publishes only this normalized word list and does not expose original source IDs, imported definitions, or account records.

The owner explicitly authorized public distribution of the union's normalized headwords in the Codex conversation on 2026-10-11 (“授权并公开”), following confirmation that this publishes the 7,048-word union. This grant covers public headword membership for WordLoop. It does not republish the source books, their definitions, order, notes, or private learning records. Public words receive dictionary information through the separately licensed ECDICT service.

`kaoyan.json` contains 7,048 alphabetically sorted normalized words, source version `owner-authorization-2026-10-11`, with empty private source-record arrays. SHA-256: `247b81b85b8c8878d7ebbb3a544b4f2d27889b7066c1a7006c26b0e44c59b00b`.

This public list replaces the earlier 5,528-word NETEM candidate. It has 5,461 words in common with that candidate: 1,587 words were added and 67 former NETEM-only words removed. The former CC BY-NC-SA terms applied to NETEM and do not govern this owner-authorized word list. Three words (cliché, non-materialistic, open-access) currently lack an exact ECDICT entry; they remain in the authorized list and no private definitions were copied.

## CET4, CET6, IELTS and TOEFL

Attribution: ECDICT contributors, https://github.com/skywind3000/ECDICT, revision `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`, MIT. See ECDICT-LICENSE.txt for the complete notice. Source CSV SHA-256: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`.

Changes: exact whitespace-delimited exam tags, existing WordLoop normalization, normalized membership uniqueness. No ky-based kaoyan dataset. Owner approved 22 review candidates with separate identities retained; six are excluded: b.c., i.e., p.m., in spite of (unsupported format), drop-out and dropout (unresolved low-confidence review).

Final counts: CET4 3,846; CET6 5,406; IELTS 5,038; TOEFL 6,973. Definitions and pronunciation are served independently by the shared ECDICT dictionary.

## Audit and publication

`manifest.json` records each book's row count and checksum. The 2026-10-11 release added 3,015 shared dictionary records and 26,791 initial membership relations. The authorized kaoyan update adds 1,587 relationships and removes 67. All writes use database uniqueness constraints; existing dictionary rows, words and learner state are preserved.

Local release audit: `.exam-books/release/`, `.exam-books/workbuddy-review/`, `.exam-books/source-research/`. WorkBuddy actual model identity was unverified (`auto`), not asserted to be DeepSeek V4.1.

Rollback public kaoyan membership/metadata from the private, access-restricted snapshot `exam_release_backup_20261011.kaoyan_netem`. Keep any enrolled cards and learner history; never remove dictionary additions referenced by learning cards.
