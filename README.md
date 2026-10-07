# WordLoop

[English](README.md) · [简体中文](README.zh-CN.md)

WordLoop is a personal English-learning system built around durable study state rather than chat history. The same learner state is exposed through two clients:

- a ChatGPT MCP App with interactive widgets;
- a standalone responsive Web App served by the same backend.

Supabase/Postgres is the source of truth for vocabulary, study sessions, attempts, FSRS state, skill evidence, capture notes, private-beta identity and analytics. WordLoop owns queueing, planning and state transitions. Model calls are constrained to content generation and semantic grading after the server has already decided what should be learned and what task should be shown.

> Package version: 0.1.0  
> Runtime: Node.js 20+, TypeScript, React 19, Supabase/Postgres, MCP Apps, ts-fsrs, Cytoscape.js.  
> This README reflects the current implementation on the latest feature line, including the 2026-10-07 local Family Graph and bilingual dictionary work.

## Core design

WordLoop deliberately separates five responsibilities.

- **FSRS decides when vocabulary is due.** ts-fsrs remains the canonical long-term vocabulary scheduler. Ordinary Lesson exercises, consolidation, Capture review and BKT never rewrite a vocabulary card's due date.
- **WordLoop decides what comes next.** Daily queues, frozen Lesson rounds, formal Review snapshots, study-session cursors and budget admission are backend-owned.
- **The deterministic planner decides the task type.** It freezes the activity, target, skill IDs, hint level, expected duration and planning reason before generation.
- **BKT estimates skill weakness; it does not schedule vocabulary.** In active mode it can supply evidence-backed skill signals to the existing Lesson planner. Shadow mode records recommendations without intervention; off disables the projection.
- **DeepSeek generates and grades inside the frozen contract.** It does not choose the queue, target word, FSRS rating or exercise type.

The browser never receives the Supabase service-role key, DeepSeek key, Shanbay bridge secret or other server-only credentials.

## Word-family learning

WordLoop now treats word families as a first-class learning layer instead of a flat list of “derivatives”.

The goal is not to dump every related form onto the learner. The system builds a **small, verified local family graph** around the current word and decides whether the learner should only inspect it, consolidate the base word, or learn one derivative now.

### What the Family system does

- Opens from the current Lesson explanation through a dedicated **Family** entry.
- Loads only a bounded one-hop neighborhood instead of a global graph.
- Distinguishes different POS nodes in the lexical knowledge layer while keeping the learner's existing lemma-level learning state canonical.
- Shows verified derivational and contrast relations with source/provenance metadata.
- Lets the learner deliberately expand another node when more context is needed.
- Can save a related word as a **future candidate** without creating a vocabulary card.
- Can start a short **Family micro-session** when the current learner state makes a new derivative appropriate.
- Activates at most **one** new derivative at the end of a successful introduction flow.
- Reuses the existing activity types, error layers, attempt history, daily time budget and FSRS initialization path.

Browsing the graph never changes vocabulary state by itself.

### Data sources

The lexical layer is source-backed rather than model-generated:

- **Open English WordNet 2025** supplies English senses and verified lexical evidence.
- **MorphyNet English derivational v1** supplies additional derivational records after lemma/POS validation against OEWN.
- **ECDICT** supplies lemma-level Chinese glosses and additional English definitions.
- A small manually reviewed fixture remains in the repository for deterministic regression tests.

Every imported lexical record keeps source, revision, license and provenance. Similar spelling, embeddings or LLM guesses are not allowed to create a relation.

### Local graph rules

The Family graph is intentionally bounded:

- server response: at most 24 nodes;
- accumulated browser graph: at most 40 nodes;
- default relation depth: one hop;
- further exploration requires explicit expansion;
- low-confidence or unsupported relations are filtered rather than guessed.

Cytoscape.js is lazy-loaded only when the Family panel opens, so ordinary Lesson startup does not pay the graph-engine cost.

### A / B / C / D learning stages

The system uses four deterministic stages to avoid overloading the learner with a whole family at once.

- **Stage A — consolidate the base.** If the base word is still new, unstable, error-heavy or under-practiced, the micro-session only reinforces the base word. No new derivative card is created.
- **Stage B — introduce one derivative.** Once the base is sufficiently stable, the system may select one high-value, transparent derivative.
- **Stage C — spaced family growth.** A later family member can be introduced only after spacing and stability guards pass across the already learned members.
- **Stage D — discriminate existing members.** When several family members are already stable, the system practices contextual discrimination among them instead of adding another new word.

Candidate scoring considers utility, exam relevance, morphological transparency, learner need and interference risk. These are deterministic v1 heuristics, not psychometric probabilities.

### Family micro-session

A Family micro-session is a short targeted lesson, typically around two minutes. It can include:

- morphology / affix explanation;
- POS recognition;
- definition recall;
- collocation or usage contrast;
- contextual extraction;
- unprompted active recall.

The session is resumable and idempotent. Intermediate answers do not create a new card. If the intended introduction is completed, WordLoop can initialize one derivative through the existing vocabulary path and create its normal FSRS state. Competing requests preserve an already-existing card instead of resetting it.

### Boundary with FSRS and BKT

The Family system is **not** a second scheduler and it does not have a separate mastery model.

- FSRS remains the only long-term vocabulary scheduler.
- BKT may provide skill-level weakness signals to the ordinary Lesson planner, but it does not choose Family due dates.
- Family candidates are only future intentions; they are not today's queue and they have no due date.
- Family graph browsing, candidate saving and Stage A consolidation do not advance vocabulary FSRS.
- Family learning never rewrites the frozen ordinary Lesson queue.

### Current coverage and limits

The current production corpus is built from a vocabulary-scoped OEWN + MorphyNet import with ECDICT enrichment. The system deliberately accepts honest empty states when a word has no verified family relation.

Not implemented yet:

- global/network-wide graph browsing;
- automatic LLM-created lexical relations;
- per-sense/POS learner mastery;
- a second family scheduler;
- graph-based reordering of the immutable formal Review queue.

Implementation and data details:

- docs/LOCAL_FAMILY_GRAPH.md
- docs/LEXICAL_CORPUS_IMPORT.md
- docs/BILINGUAL_FAMILY_DICTIONARY.md
- server/data/ATTRIBUTION.md

## Current learning flow

A normal session is driven by the backend bootstrap and persisted in study_sessions.

1. **Formal Review** — only cards in the backend due snapshot are reviewed. A genuine independent retrieval can advance the vocabulary FSRS card.
2. **Pretest** — today's new words are classified before the answer is revealed.
3. **Pronunciation handoff** — pretest cards can run listening/repetition and exact listening recall before Lesson.
4. **Lesson** — a frozen round teaches and exercises one word at a time. The model cannot reorder the round or silently replace the saved exercise.
5. **Application / consolidation** — longer translation, sentence-production or other consolidation tasks can be scheduled separately from ordinary Lesson work.
6. **Continue** — the server returns the next durable state. Clients do not infer progress from chat history.

Closing ChatGPT or refreshing the Web App does not reset the active flow. The current phase, saved payload, retry state, frozen plan and navigation cursor live in the database.

## Formal Review and FSRS

Vocabulary scheduling uses FSRS v6 through ts-fsrs.

Current vocabulary scheduler configuration:

- target retention: 0.90;
- maximum interval: 36500 days;
- short-term FSRS learning steps disabled.

WordLoop handles acquisition and same-day relearning through its Lesson flow instead of creating a parallel minute-level scheduler. Ordinary attempts never advance the long-term card. Formal Review is the only vocabulary flow allowed to write a new FSRS due state.

Capture-note review is intentionally separate. Opt-in note reviews have their own note_review_states / note_review_events and also use the existing FSRS library, but they never overwrite user_words or vocabulary Review state.

## Exercise planning and semantic grading

The Lesson planner lives under server/services/exercisePlanner.ts. It uses target sense/POS, error layers, recent task history, skill evidence, task applicability and frozen-session state.

Typical activity families include:

- word recall and exact cloze;
- Chinese-to-English translation;
- collocation;
- derivation / word-family work;
- sentence/application tasks;
- consolidation tasks.

Fixed-answer activities are graded deterministically on the server. Open semantic answers are sent to DeepSeek using strict JSON schemas and Zod validation. The current model is deepseek-flash with thinking disabled.

A saved answer and its study transition are idempotent. A retry must restore the same plan/exercise instead of generating a different question.

## BKT and learning evidence

WordLoop now has an evidence layer that is deliberately downstream of real answers and upstream of the existing planner.

- Independent first answers become observable evidence when the outcome is valid.
- Assisted completion is learning-only evidence.
- Contradictory or unassessed outcomes are ignored rather than converted into fake binary labels.
- One exercise updates a skill at most once.
- The current fixed-v1 BKT parameters are prior 0.2, learn 0.1, guess 0.2, slip 0.1.
- At least five independent observations per skill are required before active selection uses that skill state.

The canonical evidence tables are exercise_skill_evidence, bkt_updates and user_skill_state. Historical events can be replayed without touching FSRS.

learning_settings.bkt_mode supports:

- **active** — skill signals can affect future, not-yet-displayed Lesson plans;
- **shadow** — recommendations are recorded but not used;
- **off** — BKT projection and selection are disabled.

Displayed questions, formal Review order, ratings and due dates are immutable with respect to BKT.

## Daily time budget

WordLoop uses a default learning budget of 45 minutes per local day. The daily new-word count remains a ceiling rather than a promise to admit all words.

Budget admission estimates task cost before scheduling work. Overdue Review blocks new admissions, and a seven-day FSRS forecast further limits new words. Frozen sessions and already-saved answers survive a budget pause.

The user can explicitly add 15 minutes and continue. Budget exhaustion means the estimated time budget is full; it does not mean every due task has been completed.

See docs/EVIDENCE_BUDGET.md for the current evidence and budget contract.

## Standalone Web App

The root Site is a responsive study client backed by the same Supabase state and orchestration as the MCP App.

Main areas include:

- **Today / Study** — Review, Pretest, Lesson, feedback and pending consolidation;
- **Capture** — selected words, phrases, collocations, sentences and grammar snippets with source context;
- **Note Review** — optional Again/Good retrieval for explicitly enabled Capture notes;
- **Insights** — memory, due distribution, weakness and activity analytics;
- **Vocabulary** — searchable vocabulary, per-word history and FSRS state;
- **Private beta settings** — owner-only account creation for invited users.

Web requests are authenticated server-side. Private-beta accounts use Supabase Auth email/password plus the public.users allowlist; there is no public registration UI. The legacy WORDLOOP_WEB_TOKEN remains an owner/integration compatibility path and should not be distributed to beta users.

## Capture and Notes

Capture is stored independently from vocabulary learning until the user explicitly promotes an item.

The canonical Capture model stores:

- selected text and type;
- surrounding context and source metadata;
- personal interpretation / notes;
- repeated occurrence history;
- inbox/saved/linked/archived state.

Repeated encounters are deduplicated into occurrence history. Promoting an existing vocabulary item never resets its learning status or FSRS schedule. Promoting a genuinely new word can create/link the vocabulary record without rewriting the currently frozen Lesson round.

Note Review is also opt-in. Archive, conversion or an empty personal interpretation removes a note from the candidate list without deleting its saved review history.

## Local Family Graph

The standalone Lesson explanation view now includes a local **Family** entry for the current word.

The graph is intentionally local rather than global:

- one-hop graph requests;
- up to 24 nodes per server response and 40 accumulated nodes in the browser;
- Cytoscape.js is lazy-loaded only when the Family panel opens;
- explicit expansion is required to explore beyond the initial neighborhood;
- no spelling similarity, embedding clustering or LLM-generated relation is allowed to create lexical relations.

The lexical layer is separate from learner state. It uses verified sources and keeps source/revision/license/provenance on imported knowledge:

- Open English WordNet 2025 for English senses and verified semantic/morphological evidence;
- MorphyNet English derivational v1 for validated derivational records;
- ECDICT for lemma-level Chinese and additional English dictionary glosses;
- a small reviewed fixture for deterministic regression tests.

Family browsing does not create learning cards. A user can save a future candidate, or explicitly start a short Family micro-session. The micro-session uses the existing activity/error infrastructure and daily budget. Only successful completion of the intended introduction can activate one derivative; it never dumps an entire family into today's queue.

Family stages preserve interference and spacing:

- **A** — consolidate the base only;
- **B** — introduce one high-value derivative when the base is stable;
- **C** — introduce another member only after spacing and stability guards pass;
- **D** — discriminate among already learned stable members without activating a new word.

Network View, Global Graph, automatic AI relation generation and a second Family mastery/scheduler model are intentionally out of scope.

Detailed implementation notes:

- docs/LOCAL_FAMILY_GRAPH.md
- docs/LEXICAL_CORPUS_IMPORT.md
- docs/BILINGUAL_FAMILY_DICTIONARY.md
- server/data/ATTRIBUTION.md

## Pronunciation

When MERRIAM_WEBSTER_API_KEY is configured, WordLoop can request Merriam-Webster Learner's Dictionary pronunciation audio. If dictionary audio is unavailable, supported clients fall back to an English speechSynthesis voice.

Pronunciation remains presentation/practice data; it does not independently advance vocabulary FSRS.

## Shanbay import

WordLoop supports optional one-time Shanbay vocabulary migration.

The current standalone import path is an isolated Cloudflare Browser Worker:

- a per-user Durable Object owns the active import job/browser;
- the learner logs in to Shanbay inside a short-lived Live View;
- WordLoop persists bounded chunks and acknowledges them before advancing the remote cursor;
- retries reuse the pending chunk and database writes remain idempotent;
- cancellation, completion and expiry close the browser;
- cookies/passwords are not persisted in WordLoop storage or returned to the app.

Existing learning and FSRS state are preserved. The legacy server-side Shanbay adapter remains admin-only compatibility code.

See cloudflare/shanbay-import/README.md for deployment details.

## ChatGPT MCP App

Local Node development exposes MCP at:

~~~text
http://127.0.0.1:3000/mcp
~~~

The Sites/Worker deployment exposes MCP at:

~~~text
https://<your-site>/api/mcp
~~~

The important runtime rule for start/continue learning is simple: bootstrap first, then follow the returned backend action. The model must not reconstruct a queue from chat history.

MCP widgets and the standalone Web App share the same canonical learning state; render resources are UI surfaces, not alternate sources of truth.

## Architecture

~~~mermaid
flowchart LR
  C[ChatGPT MCP App] --> R[WordLoop runtime]
  W[Standalone Web App] --> R

  R --> A[Auth + study orchestration]
  A --> S[(Supabase Postgres)]
  A --> F[FSRS v6]
  A --> P[Deterministic planner]
  A --> B[BKT skill signals]

  P --> D[DeepSeek Flash]
  R --> M[Merriam-Webster audio]
  R --> H[Cloudflare Shanbay import bridge]
  R --> G[Local Family knowledge layer]

  G --> O[OEWN]
  G --> N[MorphyNet]
  G --> E[ECDICT]
~~~

server/worker.ts is the Cloudflare Worker-compatible entrypoint. server/index.ts remains the local Node/Express entrypoint.

## Project structure

~~~text
wordloop/
├── build/                         # standalone/GPT Sites shell
├── cloudflare/shanbay-import/     # isolated browser-based Shanbay bridge
├── docs/
│   ├── TEACHING_POLICY.md
│   ├── EVIDENCE_BUDGET.md
│   ├── NOTE_REVIEW_MVP.md
│   ├── PRIVATE_BETA.md
│   ├── LOCAL_FAMILY_GRAPH.md
│   ├── LEXICAL_CORPUS_IMPORT.md
│   ├── BILINGUAL_FAMILY_DICTIONARY.md
│   └── WORDLOOP_INSIGHTS_METRICS.md
├── scripts/
│   ├── bkt-calibration/
│   ├── build-family-corpus.ts
│   ├── build-ecdict-corpus.ts
│   ├── build-oewn-dictionary.ts
│   └── replay-learning-evidence.ts
├── server/
│   ├── services/
│   │   ├── bkt.ts
│   │   ├── bktPlanner.ts
│   │   ├── deepseek.ts
│   │   ├── exercisePlanner.ts
│   │   ├── familyDictionary.ts
│   │   ├── familyGraph.ts
│   │   ├── familyLesson.ts
│   │   ├── familyPolicy.ts
│   │   ├── fsrsScheduler.ts
│   │   ├── learningBudget.ts
│   │   ├── noteReviews.ts
│   │   └── studySessions.ts
│   ├── webApi.ts
│   ├── webAuth.ts
│   └── worker.ts
├── shared/
├── supabase/migrations/
├── tests/
└── web/src/
    ├── family/
    ├── lesson/
    ├── review/
    └── standalone/
~~~

## Environment variables

Copy .env.example to .env for local development and configure the server runtime.

| Variable | Required | Purpose |
| --- | --- | --- |
| SUPABASE_URL | Yes | Supabase project URL. |
| SUPABASE_SERVICE_ROLE_KEY | Yes | Server-only database credential. |
| SUPABASE_PUBLISHABLE_KEY | Private-beta Web | Browser-safe Supabase Auth key. |
| DEV_USER_ID | Owner / legacy compatibility | Trusted owner UUID used by legacy paths. |
| DEEPSEEK_API_KEY | Generated Lesson / semantic grading | Server-only DeepSeek credential. |
| WORDLOOP_WEB_TOKEN | Optional owner compatibility | Legacy owner/integration Bearer token. |
| MERRIAM_WEBSTER_API_KEY | Optional | Dictionary pronunciation audio. |
| SHANBAY_IMPORT_WORKER_URL | Optional import | Deployed browser-import Worker URL. |
| SHANBAY_IMPORT_BRIDGE_SECRET | Optional import | Shared server-to-Worker signing secret. |
| SHANBAY_AUTH_TOKEN | Legacy import only | Older admin migration adapter credential. |
| SHANBAY_COOKIE | Legacy fallback | Server-only cookie for the older adapter. |
| PORT | No | Local HTTP port; defaults to 3000. |
| HOST | No | Bind address; defaults to 127.0.0.1. |
| PUBLIC_BASE_URL | Deployment | Public origin used by deployment/configuration. |
| ALLOWED_HOSTS | Recommended when public | DNS-rebinding protection. |
| WORDLOOP_ROOT | Rare | Explicit project root. |
| ENABLE_WIDGET_PREVIEW | Development only | Enables local widget preview routes. |
| WORDLOOP_PERF_LOG | Optional debugging | Emits opt-in model timing diagnostics. |

Server-only secrets must never be embedded in build/ or browser bundles.

## Database and migrations

For a fresh database, apply the current setup.sql.

For an existing database, apply only missing migrations in order. The current feature line includes these relevant migrations:

- `202609290001_capture_notes.sql` — initial Capture storage;
- `20260929120641_captured_notes.sql` — canonical captured-notes model;
- `20260929172617_captured_notes_canonical_adapter.sql` — canonical Capture adapter;
- `20260929172621_analytics_read_models.sql` — analytics read models;
- `20260929184221_progress_scheduled_stability_mean.sql` — scheduled Stability analytics;
- `20260930043404_balanced_exercise_plans.sql` and `20260930043648_exercise_plan_fk_indexes.sql` — durable frozen exercise plans;
- `20260930141500_consolidation_target_attribution.sql` — consolidation target attribution;
- `202610020001_note_review_states.sql` — opt-in Note Review state/events;
- `20261002024106_evidence_budget.sql` — learning evidence, BKT projection and daily budget;
- `20261004045839_bkt_active_planner.sql` — active/shadow/off BKT planner control;
- `20261004164746_cross_day_review_handoff.sql` — cross-day Review handoff;
- `20261007025825_captured_note_deduplication.sql` — Capture deduplication;
- `20261007053500_local_family_graph.sql` — Local Family Graph knowledge/user tables;
- `20261007095603_lexical_dictionary_entries.sql` — bilingual lexical dictionary entries.

The lexical knowledge imports are additive and must not rewrite user_words, attempts, FSRS state or frozen study_sessions.

## Install and run

Requirements:

- Node.js 20+;
- a migrated Supabase project.

~~~bash
npm install
cp .env.example .env
npm run dev
~~~

Production build:

~~~bash
npm run build
npm start
~~~

Useful checks:

~~~bash
npm run typecheck
npm test
npm run build
npm run check:db
npm run predeploy:check
~~~

Replay pending learning evidence without changing source attempts or FSRS:

~~~bash
npm run evidence:replay
~~~

MCP Inspector:

~~~bash
npx @modelcontextprotocol/inspector --web http://127.0.0.1:3000/mcp
~~~

## Private beta and security

The current product supports a small invited multi-user beta.

- Supabase Auth verifies email/password sessions.
- public.users is the application allowlist; a valid Auth account alone does not grant access.
- There is no public signup UI.
- The owner can create beta accounts from the authenticated private-beta settings surface.
- Every Web API and authenticated MCP tool call resolves identity server-side.
- Service-role, DeepSeek and import-bridge credentials remain server-only.
- RLS is enabled on the additive user and lexical tables; privileged RPC access is restricted to the service runtime where applicable.
- Banning/revoking an Auth user removes access without requiring deletion of their learning data.

See docs/PRIVATE_BETA.md for account creation, recovery and revocation procedures.

## Data provenance

WordLoop keeps lexical-source attribution with the imported knowledge.

Application/runtime code and imported datasets have different licenses. In particular, OEWN, Princeton WordNet, MorphyNet, ECDICT and Cytoscape.js each retain their own notices and attribution requirements.

See server/data/ATTRIBUTION.md and server/data/licenses/ before redistributing lexical data or generated bundles.

## Current limitations

- Family Graph is local and one-hop by design; Global/Network View is not implemented.
- Family utility/exam/interference thresholds are deterministic v1 rules, not calibrated psychometric scores.
- BKT fixed-v1 parameters are not yet fitted from a large personal dataset; active mode is bounded by minimum-evidence guards.
- Lemma-level learner state is still shared across POS/sense nodes; per-sense mastery is not implemented.
- ECDICT coverage is high but not complete, and lemma-level Chinese glosses are not asserted to be synset translations.
- Shanbay Browser import still requires real-user acceptance under Cloudflare browser quota and Shanbay login conditions.
- Some historical analytics remain unavailable when old events do not contain enough evidence.

## Teaching policy

The human-readable teaching contract is maintained in:

- docs/TEACHING_POLICY.md

The runtime prompt is maintained in:

- server/teachingPrompt.ts

They should stay synchronized whenever learning behavior changes.
