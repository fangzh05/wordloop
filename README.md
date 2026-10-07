# WordLoop

[English](README.md) · [简体中文](README.zh-CN.md)

WordLoop is a personal English-learning system built around **durable learner state, controlled retrieval practice, and explicit learning policy** rather than chat history.

It exposes the same state through two clients:

- a ChatGPT MCP App with interactive widgets;
- a standalone responsive Web App.

The product is designed for long-term vocabulary acquisition, active recall, usage practice, reading capture, weak-skill diagnosis, and controlled word-family expansion. Supabase/Postgres is the source of truth. FSRS schedules long-term vocabulary review. BKT estimates skill-level weakness. A deterministic planner decides what task to show. DeepSeek is restricted to content generation and semantic grading after the plan has already been fixed.

> Package: `0.1.0`  
> Runtime: Node.js 20+, TypeScript, React 19, Supabase/Postgres, MCP Apps, ts-fsrs, Cytoscape.js  
> Current feature-complete product line: `codex/local-family-graph`

## Product model

WordLoop is not a generic AI tutor and not a flashcard wrapper. It separates the learning problem into several independent layers:

| Layer | Responsibility |
| --- | --- |
| Vocabulary state | One canonical learner record per normalized word |
| Long-term memory | FSRS decides when a vocabulary item is due |
| Study orchestration | WordLoop decides the next durable step |
| Exercise planning | A deterministic planner freezes task type, target and skill intent |
| Skill diagnosis | BKT estimates weakness from valid answer evidence |
| Generation / semantic grading | DeepSeek operates only inside the frozen task contract |
| Reading capture | Capture stores encounters and context separately from the vocabulary queue |
| Word-family learning | A verified local lexical graph controls family expansion |
| Analytics | Read-only metrics expose memory, errors, activity and due workload |
| Authentication | Supabase Auth + invite allowlist support a small private beta |

The central rule is simple: **no subsystem is allowed to quietly become a second vocabulary scheduler**.

FSRS owns long-term vocabulary due dates. BKT does not move them. Capture does not move them. Family Graph does not move them. Ordinary Lesson exercises do not move them.

## Learning loop

A normal study session is server-owned and resumable:

~~~text
Due Review
   ↓
Pretest
   ↓
Pronunciation / listening recall
   ↓
Frozen Lesson round
   ↓
Application / consolidation
   ↓
Optional Family micro-session
   ↓
Continue from durable backend state
~~~

The backend stores the current phase, word, frozen plan, generated payload, retry state and navigation cursor in `study_sessions`. Closing ChatGPT, refreshing the Web App or reopening the product does not require reconstructing progress from conversation text.

### 1. Formal Review

Formal Review only uses the current backend due snapshot.

- FSRS v6 is the canonical vocabulary scheduler.
- Target retention: `0.90`.
- Maximum interval: `36500` days.
- `enable_short_term: false`.
- Only a genuine independent retrieval can advance a vocabulary card.
- Ordinary Lesson attempts, correction after seeing an answer, Capture review and Family browsing do not advance vocabulary FSRS.

### 2. Pretest and pronunciation

New words enter through a pretest before formal teaching.

The current flow supports:

- Chinese core meaning → English word;
- English word + POS → simple English definition;
- pronunciation listening/repetition;
- listening recall before Lesson handoff.

When configured, pronunciation uses Merriam-Webster Learner's Dictionary audio. Supported clients fall back to an English `speechSynthesis` voice when dictionary audio is unavailable.

### 3. Frozen Lesson planning

Lesson planning is deterministic and server-owned.

Before generation, WordLoop freezes:

- target word / sense;
- activity type;
- skill IDs;
- hint level;
- expected duration;
- planning reason;
- stable plan / exercise IDs.

Typical task families include:

- word recall;
- exact cloze;
- Chinese-to-English translation;
- collocation;
- derivation / word-family work;
- sentence/application tasks;
- consolidation.

A retry restores the same saved plan rather than silently changing the question.

### 4. Deterministic grading + DeepSeek

Fixed-answer activities are graded deterministically on the server.

Open semantic answers are sent to DeepSeek only when semantic judgment is necessary. Model output must pass strict JSON schemas and Zod validation before it can affect learning state.

DeepSeek does **not** choose:

- the next word;
- the Review queue;
- the exercise type;
- the FSRS rating;
- the vocabulary due date.

### 5. BKT skill model

BKT sits between validated answer evidence and future Lesson planning.

The current fixed-v1 model uses:

- prior: `0.2`;
- learn: `0.1`;
- guess: `0.2`;
- slip: `0.1`.

Evidence policy:

- independent first answers can become `OBSERVE`;
- assisted completion becomes `LEARN_ONLY`;
- contradictory or unusable evidence becomes `IGNORE`;
- one exercise updates one skill at most once;
- active planning requires at least five independent observations for that skill.

Modes:

- `active`: skill signals can affect future, not-yet-displayed Lesson plans;
- `shadow`: recommendations are recorded but not used;
- `off`: BKT projection and selection are disabled.

BKT cannot alter already displayed questions, formal Review order, Review ratings or FSRS due dates.

### 6. Daily time budget

The default learning budget is 45 minutes per local day.

The daily new-word limit remains a ceiling. WordLoop estimates task cost before admitting new work, prioritizes overdue Review, and uses a short FSRS workload forecast to avoid overloading future days.

The user can explicitly add 15 minutes. A budget stop means estimated study time is exhausted; it does not mean every due item has been completed.

See `docs/EVIDENCE_BUDGET.md`.

## Word-family learning

Word-family learning is a first-class product capability.

The goal is not to show an uncontrolled list of derivatives. WordLoop builds a **small, verified local family graph** around the current word and decides whether the learner should:

- only browse;
- consolidate the base;
- save a related word for later;
- learn one derivative now;
- discriminate among already learned family members.

### Local graph

The graph is intentionally bounded:

- one-hop by default;
- up to 24 nodes per server response;
- up to 40 accumulated nodes in the browser;
- explicit expansion for deeper exploration;
- Cytoscape.js lazy-loaded only when the Family panel opens.

Relations cannot be created from spelling similarity, embeddings or model guesses.

### Data sources

The lexical layer is source-backed:

- **Open English WordNet 2025** — English senses and verified lexical evidence;
- **MorphyNet English derivational v1** — validated derivational records;
- **ECDICT** — lemma-level Chinese glosses and additional English definitions;
- a small reviewed fixture — deterministic regression coverage.

Imported lexical records retain source, revision, license and provenance.

### A / B / C / D stages

- **A — consolidate the base.** No new derivative is activated while the base is unstable or error-heavy.
- **B — introduce one derivative.** A stable base can unlock one high-value, transparent derivative.
- **C — spaced family growth.** Additional members require both spacing and stability guards.
- **D — discriminate known members.** Once several family members are stable, practice shifts toward contextual discrimination instead of adding another word.

A Family micro-session is short, resumable and idempotent. It can use morphology explanation, POS recognition, definition recall, collocation, contextual extraction and active recall.

Browsing or saving a candidate does not create a vocabulary card. A completed introduction can activate at most one derivative through the existing vocabulary/FSRS path.

Family Graph has no second mastery model and no second scheduler.

Detailed docs:

- `docs/LOCAL_FAMILY_GRAPH.md`
- `docs/LEXICAL_CORPUS_IMPORT.md`
- `docs/BILINGUAL_FAMILY_DICTIONARY.md`
- `server/data/ATTRIBUTION.md`

## Capture and Note Review

Capture records reading encounters without forcing them into the learning queue.

A captured item can store:

- selected text;
- type: word, phrase, collocation, sentence or grammar;
- surrounding context;
- source metadata;
- personal interpretation / note;
- repeated occurrence history;
- inbox / saved / linked / archived state.

Repeated encounters are deduplicated into occurrence history.

Promotion is explicit:

- linking an existing vocabulary item does not reset status or FSRS;
- creating a genuinely new vocabulary item does not rewrite the currently frozen Lesson round.

Note Review is opt-in and separate from vocabulary Review. It uses its own `note_review_states` and `note_review_events` and never overwrites `user_words`.

See `docs/NOTE_REVIEW_MVP.md`.

## Insights and vocabulary

The standalone product includes read-only analytics and searchable vocabulary views.

Current analytics include:

- long-term first-recall success rate;
- current memory-set size;
- FSRS Stability, Difficulty and Retrievability;
- overdue / due / future due distribution;
- active error layers;
- historical error matrix by activity type;
- formal Review activity;
- first introductions;
- Capture activity;
- focus-word ranking.

Historical values are shown only when stored events can support them. Missing history is reported as unavailable rather than fabricated.

Metric definitions live in `docs/WORDLOOP_INSIGHTS_METRICS.md`.

## Product surfaces

### Standalone Web App

The root Site is the full responsive study client.

Primary areas:

- Today / Study;
- Capture;
- Note Review;
- Insights;
- Vocabulary;
- private-beta settings.

### ChatGPT MCP App

Local MCP endpoint:

~~~text
http://127.0.0.1:3000/mcp
~~~

Sites / Worker endpoint:

~~~text
https://<your-site>/api/mcp
~~~

For “start learning” or “continue learning”, the first operation must be bootstrap. The model follows the backend action; it must not reconstruct the queue from chat history.

Both clients use the same canonical learner state.

## Shanbay import

WordLoop supports optional one-time Shanbay vocabulary migration.

The current standalone flow uses an isolated Cloudflare Browser Worker:

- one active Durable Object / browser job per verified WordLoop user;
- short-lived Live View login;
- bounded chunk persistence;
- acknowledgement before remote cursor advance;
- idempotent retry behavior;
- browser teardown on completion, cancellation or expiry.

Cookies and passwords are not stored by WordLoop or returned to the Web App.

Existing learning and FSRS state are preserved.

See `cloudflare/shanbay-import/README.md`.

## Private beta authentication

The current product supports a small invite-only multi-user beta.

- Supabase Auth verifies email/password sessions.
- `public.users` acts as the WordLoop allowlist.
- There is no public signup UI.
- The owner can create invited accounts.
- The legacy `WORDLOOP_WEB_TOKEN` remains an owner/integration compatibility path only.
- User identity is resolved server-side for Web API and authenticated MCP calls.

See `docs/PRIVATE_BETA.md`.

## Architecture

~~~mermaid
flowchart LR
  U[User] --> C[ChatGPT MCP App]
  U --> W[Standalone Web App]

  C --> R[WordLoop Runtime]
  W --> R

  R --> A[Auth + Study Orchestration]
  A --> S[(Supabase/Postgres)]

  A --> F[FSRS v6]
  A --> P[Deterministic Exercise Planner]
  A --> B[BKT Skill State]

  P --> D[DeepSeek Flash]

  R --> G[Local Family Layer]
  G --> O[OEWN]
  G --> M[MorphyNet]
  G --> E[ECDICT]

  R --> MW[Merriam-Webster Audio]
  R --> SH[Cloudflare Shanbay Import Bridge]
~~~

The application deliberately separates learner state, lexical knowledge, model generation and UI rendering.

## Core persistence

Representative canonical data areas include:

| Area | Canonical storage |
| --- | --- |
| Vocabulary / FSRS | `user_words`, `fsrs_review_logs` |
| Attempts / error evidence | `attempts`, error progress tables |
| Durable study flow | `study_sessions.state` |
| Exercise plans | persisted plan / exercise records |
| Skill evidence / BKT | `exercise_skill_evidence`, `bkt_updates`, `user_skill_state` |
| Capture | `captured_notes`, `captured_note_occurrences` |
| Note Review | `note_review_states`, `note_review_events` |
| Family knowledge | lexical lexeme/sense/form/relation tables |
| Family user state | candidates, exposures and micro-sessions |
| Private beta | Supabase Auth + `public.users` allowlist |

## Project structure

~~~text
wordloop/
├── build/                         # standalone / GPT Sites shell
├── cloudflare/shanbay-import/     # isolated browser import bridge
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
│   ├── tools/
│   ├── mcpCore.ts
│   ├── webApi.ts
│   ├── webAuth.ts
│   └── worker.ts
├── shared/
├── supabase/migrations/
├── tests/
└── web/src/
    ├── dashboard/
    ├── family/
    ├── lesson/
    ├── pretest/
    ├── review/
    └── standalone/
~~~

## Environment variables

Copy `.env.example` to `.env` for local development.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only database credential |
| `SUPABASE_PUBLISHABLE_KEY` | Private-beta Web | Browser-safe Supabase Auth key |
| `DEV_USER_ID` | Owner / legacy paths | Trusted owner UUID |
| `DEEPSEEK_API_KEY` | Generated Lesson / semantic grading | Server-only model credential |
| `WORDLOOP_WEB_TOKEN` | Optional owner compatibility | Legacy owner/integration Bearer token |
| `MERRIAM_WEBSTER_API_KEY` | Optional | Dictionary pronunciation audio |
| `SHANBAY_IMPORT_WORKER_URL` | Optional import | Browser-import Worker URL |
| `SHANBAY_IMPORT_BRIDGE_SECRET` | Optional import | Server-to-Worker signing secret |
| `SHANBAY_AUTH_TOKEN` | Legacy import | Older admin adapter credential |
| `SHANBAY_COOKIE` | Legacy fallback | Older adapter cookie |
| `PORT` | No | Local HTTP port, default 3000 |
| `HOST` | No | Bind address, default 127.0.0.1 |
| `PUBLIC_BASE_URL` | Deployment | Public product origin |
| `ALLOWED_HOSTS` | Recommended when public | DNS-rebinding protection |
| `WORDLOOP_ROOT` | Rare | Explicit project root |
| `ENABLE_WIDGET_PREVIEW` | Development only | Local widget preview routes |
| `WORDLOOP_PERF_LOG` | Optional debugging | Performance diagnostics on branches that contain the latency instrumentation |

Secrets must remain server-side and must not be embedded in browser bundles.

## Database setup and migrations

For a fresh database, apply the current `setup.sql`.

For an existing database, apply only missing migrations in order. Important migrations on the current product line include:

- `202609290001_capture_notes.sql`
- `20260929120641_captured_notes.sql`
- `20260929172617_captured_notes_canonical_adapter.sql`
- `20260929172621_analytics_read_models.sql`
- `20260929184221_progress_scheduled_stability_mean.sql`
- `20260930043404_balanced_exercise_plans.sql`
- `20260930043648_exercise_plan_fk_indexes.sql`
- `20260930141500_consolidation_target_attribution.sql`
- `202610020001_note_review_states.sql`
- `20261002024106_evidence_budget.sql`
- `20261004045839_bkt_active_planner.sql`
- `20261004164746_cross_day_review_handoff.sql`
- `20261007025825_captured_note_deduplication.sql`
- `20261007053500_local_family_graph.sql`
- `20261007095603_lexical_dictionary_entries.sql`

These explicit filenames are also part of repository migration/test contracts.

Lexical knowledge imports are additive and must not rewrite learner vocabulary, attempts, FSRS state or frozen study sessions.

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

Validation:

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

## Development status

The current feature-complete product line is `codex/local-family-graph`.

It contains the current BKT, budget, Capture/Note Review, private-beta authentication, Local Family Graph, lexical corpus and bilingual dictionary work.

PR #2 / the latency-optimization work was merged into the sibling `codex/exercise-balanced-learning-flow` line on 2026-10-07. That code line contains compact semantic grading, reduced model-output ceilings, frozen-plan write reduction and additional timing diagnostics. Those changes are **not claimed as present in this branch until the two lines are actually merged**.

This distinction is intentional: the README should describe code that exists, not a conceptual superset that no single branch currently contains.

## Current limits

- No Global / Network-wide Family Graph yet.
- No LLM-generated lexical relations.
- No per-sense / per-POS learner mastery model.
- BKT fixed-v1 parameters are not yet fitted from a large personal dataset.
- ECDICT glosses are lemma-level and are not asserted to be synset translations.
- Some historical analytics remain unavailable where older events do not contain enough evidence.
- Shanbay Browser import still depends on real Shanbay login conditions and Cloudflare browser quota.
- The two active feature lines still need code-level convergence before there is one single branch containing both Family/BKT/private-beta work and PR #2 latency optimization.

## Documentation index

- `docs/TEACHING_POLICY.md` — learning behavior and ChatGPT teaching contract
- `docs/EVIDENCE_BUDGET.md` — evidence semantics, BKT boundaries and daily time budget
- `docs/NOTE_REVIEW_MVP.md` — Capture Note Review
- `docs/PRIVATE_BETA.md` — authentication and invited-account operation
- `docs/LOCAL_FAMILY_GRAPH.md` — Family Graph implementation
- `docs/LEXICAL_CORPUS_IMPORT.md` — OEWN/MorphyNet corpus import
- `docs/BILINGUAL_FAMILY_DICTIONARY.md` — ECDICT/OEWN bilingual dictionary enrichment
- `docs/WORDLOOP_INSIGHTS_METRICS.md` — analytics definitions and evidence limits
- `server/data/ATTRIBUTION.md` — lexical data provenance and licenses

The human-readable teaching policy and `server/teachingPrompt.ts` should remain synchronized when learning behavior changes.
