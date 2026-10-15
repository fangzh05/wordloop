# Private Anki Lesson cache

This is an offline import path for the 2027 Redbook APKG from `CHNragdoll/anki-pipeline`. The APKG and extracted JSONL, manifest, checkpoint, and report must live outside this checkout. Only mapped text fields are extracted; audio and media are not copied.

## Staging-only setup

The importer rejects any Data API host except the dedicated staging branch endpoint. Supply these values through the local process environment, never through a committed file or command-line argument:

- `WORDLOOP_STAGING_NEON_BRANCH_ID=br-spring-unit-azxctyf3`
- `WORDLOOP_STAGING_NEON_DATA_API_URL` for that branch
- `WORDLOOP_STAGING_NEON_WORKER_JWT_PRIVATE_JWK`
- `WORDLOOP_STAGING_SUPABASE_URL`
- `WORDLOOP_STAGING_USER_ID` for an existing staging identity authorized for both private source memberships
- optionally `WORDLOOP_STAGING_NEON_JWT_AUDIENCE` and `WORDLOOP_STAGING_NEON_JWT_ISSUER`

The supplied `--user-id` must own both `ougkp` and `athgc` private source memberships, and each imported word must belong to that user's union. The database RLS policy independently checks those conditions on every cache read and write.

The batch walks the authorized WordLoop private union as its primary list. APKG notes are attached only when `normalized_word` maps to exactly one private-union word. Words without an unambiguous APKG note still enter the CodeBuddy completion queue using the WordLoop word and saved senses as context; they are marked with the `wordloop-private-kaoyan-union-v1` source version and never receive an empty APKG-material row. Ambiguous APKG mappings are treated as missing and are not reused.

## Commands

Extract only, without database access, model calls, or writes:

```powershell
python scripts/extract-anki-lesson-materials.py `
  --apkg "$env:LOCALAPPDATA\WordLoopPrivate\anki-lesson-cache\2027-RedBook-Full-Unified-20261015.apkg" `
  --private-data-dir "$env:LOCALAPPDATA\WordLoopPrivate\anki-lesson-cache"
```

Import and complete one test word on staging with CodeBuddy DeepSeek low:

```powershell
npm run lesson:import-anki-cache -- --apkg "$env:LOCALAPPDATA\WordLoopPrivate\anki-lesson-cache\2027-RedBook-Full-Unified-20261015.apkg" --private-data-dir "$env:LOCALAPPDATA\WordLoopPrivate\anki-lesson-cache" --user-id "$env:WORDLOOP_STAGING_USER_ID" --limit 1 --report "staging-one-word.json"
```

The default model is `deepseek-v4.1-flash`, with CodeBuddy CLI `--effort low`, `--no-session-persistence`, and only the CLI's `StructuredOutput` tool enabled; no general tools are exposed. The CLI receives the missing-field JSON Schema through `--json-schema`, and the prompt is sent over standard input. The generator requests only fields missing from trusted Anki and WordLoop data, merges those fields locally, then validates the complete object with the current `LessonGeneration` Zod schema and frozen-plan validator. The parser reads the CLI's JSON event stream, unwraps the structured result, and rejects plain text.

`--import-only` stores mapped Anki material without CodeBuddy calls. A full run processes words serially. Use `--resume` to load the private checkpoint; use `--retry-failed` with `--resume` to retry only failed entries. `--limit N` bounds a run. `--dry-run` extracts and counts source records without reading or writing the database or calling CodeBuddy.

The checkpoint key includes APKG hash, user, content/prompt versions, model, lesson profile, planned activity type, and error focus. A validated Lesson is checkpointed before its database upsert so a database retry can reuse it without another model request. Token totals, credits, and USD cost are reported only when the CLI supplies exact values; otherwise the corresponding field is `unavailable`.

Cache entries are private per user and private-set ID. Complete Lesson rows include the target-sense fingerprint, normalized frozen plan inputs (excluding only random plan/exercise IDs), profile, error focus, content/prompt versions, source version, provenance, validation state, model and token-availability fields. Changed outputs add a new payload-hash row, preserving prior versions. The runtime handler only selects valid rows matching the current profile and exact plan key; the planner, Lesson UI, session snapshot structure, progress state, budgets, and scoring are unchanged.

## Staging rollback

No production migration or write is part of this task. To roll back this migration on the staging branch after exporting any desired test report, run the following as one transaction:

```sql
BEGIN;
DROP TABLE public.lesson_generation_cache;
DROP FUNCTION public.can_access_personal_kaoyan_union_v1(uuid);
COMMIT;
```

This removes only the new cache table, its policies/triggers/indexes, and its access-check function. It does not alter vocabulary, source membership, user learning state, or sessions.

## Resumable small batches

After extracting and importing materials, resume the same private v4 checkpoint with:

```powershell
npm run lesson:complete-anki-cache -- --materials-jsonl "$privateDir/anki-lesson-materials.jsonl" --manifest "$privateDir/anki-lesson-materials.manifest.json" --private-data-dir "$privateDir" --user-id "$env:WORDLOOP_STAGING_USER_ID" --resume --retry-failed --batch-size 8 --report batch-report.json
```

This uses one CodeBuddy process at a time, DeepSeek `deepseek-v4.1-flash`, `--effort low`. The shared rules and deduplicated Schema apply independently to each word. Canonical `word_recall` exercises are constructed deterministically; AI supplies missing teaching fields only. There is no concurrency or quota bypass. Smaller batches may be needed when CLI output or command limits reject larger ones.

Raw structured outputs are saved before validation/import. A per-word cache-key index allows recovery even when a later run regroups batches; invalid outputs are removed from the recovery queue before requesting corrections. Validated Lessons are also checkpointed before database writes. Retry counts accumulate across runs; reports separately describe this run's retry queue and CLI calls. An infrastructure failure keeps its own safe error code. Credentials, sessions and full CLI event streams are not saved.

Create `STOP_AFTER_BATCH` inside the private data directory to stop after the current batch. Remove it before resuming. Keep this directory outside Git and public assets. Source JSONL and checkpoint versions are checked against the authorized user, APKG hash, model, profile and plan configuration. Never delete the current checkpoint or raw outputs to retry failed imports.

`private-union-export.jsonl` and its manifest contain the exact authorized union, counts, sense count and SHA-256. They are private artifacts, not a new public vocabulary source.

CLI token totals remain batch totals; individual database rows use null when exact per-word usage is unavailable. `cli_reported_model_cost_usd` is a CLI statistic, not an account invoice. Actual monetary cost and CodeBuddy credits are `unavailable` unless independently supplied by the provider. No estimated charge is reported as actual cost.

## Read-only cache verification

```powershell
node --import tsx scripts/check-private-anki-cache.ts --materials-jsonl "$privateDir/anki-lesson-materials.jsonl" --private-data-dir "$privateDir" --user-id "$env:WORDLOOP_STAGING_USER_ID" --limit 20
```

This calls the real cache lookup in the staging user context. It checks matching conditions, new session plan IDs and a changed error focus. It writes no sessions and invokes no model. The report distinguishes union coverage from the sampled hit rate. Current offline runs cover the configured profile/activity; other planner conditions safely miss. Production traffic is not switched by these tools.

## Historical checkpoints

Earlier checkpoints must not be relabelled as v4. Old material-only entries remain useful source data; old Lessons need validation against their original frozen plan and the current canonical answer rules. A superseded revision can be marked non-valid while preserving its row and newer revision. Never remove learning history, sessions, user words, or unrelated checkout changes as cache cleanup.

Validated model batches are imported with one idempotent UPSERT of at most 32 rows. RLS and the authenticated-user trigger still validate every row. If a batch write fails, bounded individual writes isolate the failing row; all validated payloads remain checkpointed before the write.

Language review may remove explicitly identified low-value generated array items using `scripts/apply-private-cache-reviews.ts --corrections <private-json>`, under the same staging identity. The review tool refuses to remove trusted Anki arrays, validates the replacement Lesson and preserves the old row as a superseded revision.
