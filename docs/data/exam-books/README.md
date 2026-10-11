# WordLoop public exam book data

The JSON files contain public normalized headword memberships and source record numbers only. They contain no private word_sources, definitions from commercial books, or learner data.

## Kaoyan

Attribution: exam-data/NETEMVocabulary contributors, https://github.com/exam-data/NETEMVocabulary, revision `70dc6b68c855f21e666a7a291ff8ead5ca1f7b44`.

The data, including `kaoyan.json`, is licensed under **CC BY-NC-SA 4.0**, https://creativecommons.org/licenses/by-nc-sa/4.0/. See KAOYAN-LICENSE.txt for the full license. WordLoop's owner explicitly confirmed noncommercial use and ShareAlike distribution on 2026-10-11. The source's MIT license applies to code, not this data. WordLoop's software license does not relicense these files.

Changes: extracted only main headwords, applied existing WordLoop trim/lowercase normalization, collapsed two exact duplicates, retained source record numbers. All 154 other-spelling annotations are excluded from membership; no identities are merged. Source definitions, example sentences, classification and frequency rankings are not distributed here. 5,530 source rows yield 5,528 unique main headwords. Original JSON SHA-256: `6d71a301321056291902bc4804e223c6926dca0d629a45076a6ca5adab185f62`.

This is an independent public dataset. It is not the original owner's private 7,048-word Hongbaoshu/familiar-word union and does not include that account's private content. The owner retains their private source union and learning state.

## CET4, CET6, IELTS and TOEFL

Attribution: ECDICT contributors, https://github.com/skywind3000/ECDICT, revision `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`, MIT. See ECDICT-LICENSE.txt for the complete notice. Source CSV SHA-256: `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`.

Changes: exact whitespace-delimited exam tags, existing WordLoop normalization, normalized membership uniqueness. No ky-based kaoyan dataset. Owner approved 22 review candidates with separate identities retained; six are excluded: b.c., i.e., p.m., in spite of (unsupported format), drop-out and dropout (unresolved low-confidence review).

Final counts: CET4 3,846; CET6 5,406; IELTS 5,038; TOEFL 6,973. Definitions and pronunciation are served independently by the shared ECDICT dictionary.

## Audit and publication

manifest.json binds each book's membership checksum and source version. The release adds 3,015 missing dictionary records and 26,791 membership relations; inserts use unique constraints and do not update existing rows. WorkBuddy suggestions are advisory; formal ECDICT review approval came from the human owner. WorkBuddy actual model identity was unverified (`auto`), not asserted to be DeepSeek V4.1.

Local complete audit: `.exam-books/release/`, `.exam-books/workbuddy-review/`, `.exam-books/source-research/`. Pre-release scoped production backup: non-public schema `exam_release_backup_20261011` (dictionary/catalog/memberships); a temporary-table restore of all 23,432 existing dictionary rows was compared exactly before import. This is a scoped in-database backup, not an independently verified full-project disaster-recovery backup.

Rollback publication by setting `is_public=false,is_available=false,published_at=null` on exam_books. Preserve all enrolled cards and learning history. The captured pre-release catalog remains in the private backup schema; do not delete dictionary additions referenced by learning cards.
