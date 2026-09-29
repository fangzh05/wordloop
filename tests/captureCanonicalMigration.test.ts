import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20260929172617_captured_notes_canonical_adapter.sql", import.meta.url), "utf8");
const analyticsMigration = readFileSync(new URL("../supabase/migrations/20260929172621_analytics_read_models.sql", import.meta.url), "utf8");

describe("canonical Capture migration", () => {
  it("keeps the legacy tables and records an idempotent ownership-aware mapping", () => {
    expect(migration).toContain("create table if not exists public.capture_note_legacy_map");
    expect(migration).toContain("foreign key (user_id, captured_note_id)");
    expect(migration).toContain("legacy_occurrence.id");
    expect(migration).toContain("legacy_occurrence.created_at");
    expect(migration).toContain("legacy.linked_word_id");
    expect(migration).toContain("captured_notes_user_normalized_text_key unique (user_id, normalized_text)");
    expect(migration).toContain("captured_note_occurrences_user_idempotency_key_key unique (user_id, idempotency_key)");
    expect(migration).toContain("CAPTURE_CANONICAL_ORPHAN_OCCURRENCE");
    expect(migration).not.toMatch(/drop\s+table\s+(if\s+exists\s+)?public\.capture_notes/i);
    expect(migration).not.toMatch(/drop\s+table\s+(if\s+exists\s+)?public\.capture_note_occurrences/i);
  });

  it("updates parent recency transactionally and serializes same-day import positions", () => {
    expect(migration).toContain("set updated_at = greatest(updated_at, clock_timestamp())");
    expect(migration).toMatch(/from\s+public\.daily_imports[\s\S]*?for update/i);
    expect(migration).toContain("select coalesce(max(position) + 1, 0)");
    expect(migration).toMatch(/when legacy\.status = 'archived' then 'dismissed'[\s\S]*?when uw\.id is not null then 'converted'/);
    expect(migration).toContain("cardinality(regexp_split_to_array(btrim(p_display_text), '[[:space:]]+')) > 2");
  });

  it("preserves broad grants boundaries and row-level security on the audit mapping", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke all on table public.capture_note_legacy_map from public, anon, authenticated");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("grant execute on function public.create_captured_note_v1");
    expect(migration).toContain("grant execute on function public.promote_captured_note_v1");
  });
});

describe("analytics read model migration", () => {
  it("selects the first formal review before interval/rating eligibility and uses stable tie ordering", () => {
    expect(analyticsMigration).toMatch(/distinct on \(logs\.word_id,\s*\(logs\.reviewed_at at time zone params\.timezone\)::date\)/i);
    expect(analyticsMigration).toMatch(/logs\.reviewed_at,\s*logs\.id/i);
    expect(analyticsMigration).toContain("logs.review_source = 'review'");
    expect(analyticsMigration).toContain("first_formal_review.scheduled_days >= 1");
    expect(analyticsMigration).toContain("first_formal_review.rating is null");
  });

  it("keeps owner-scoped read models server-only with fixed search paths", () => {
    expect(analyticsMigration.match(/security invoker/gi)?.length).toBe(5);
    expect(analyticsMigration.match(/set search_path = public, pg_temp/gi)?.length).toBe(5);
    expect(analyticsMigration.match(/grant execute on function public\.(?:get_analytics_|list_user_vocabulary_)/gi)?.length).toBe(5);
    expect(analyticsMigration).toContain("from public.fsrs_review_logs as logs");
    expect(analyticsMigration).toContain("from public.captured_note_occurrences as occurrence");
  });
});
