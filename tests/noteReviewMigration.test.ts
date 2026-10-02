import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/202610020001_note_review_states.sql", import.meta.url), "utf8");

describe("Capture note review migration contract", () => {
  it("uses only independent note-review state and event tables", () => {
    expect(migration).toContain("create table if not exists public.note_review_states");
    expect(migration).toContain("create table if not exists public.note_review_events");
    expect(migration).toContain("foreign key (user_id, captured_note_id)");
    expect(migration).toContain("unique (user_id, idempotency_key)");
    expect(migration).not.toMatch(/(?:insert|update|delete)\s+(?:into\s+)?public\.(?:words|user_words|daily_imports|daily_import_words|study_sessions|attempts|fsrs_review_logs)/i);
  });

  it("filters eligibility at read, enable, and rating boundaries", () => {
    expect(migration).toContain("n.status in ('inbox', 'saved')");
    expect(migration).toContain("n.converted_user_word_id is null");
    expect(migration).toContain("length(btrim(n.note)) > 0");
    expect(migration).toContain("if p_enabled and length(btrim(v_note.note)) = 0");
    expect(migration).toContain("if v_state.due > p_server_time then raise exception 'NOTE_REVIEW_NOT_DUE'");
  });

  it("serializes concurrent/idempotent writes and preserves disabled cards", () => {
    expect(migration).toMatch(/from public\.captured_notes[\s\S]*?for update;/i);
    expect(migration).toMatch(/from public\.note_review_states[\s\S]*?for update;/i);
    expect(migration).toContain("v_event.request_payload <> p_request_payload");
    expect(migration).toContain("return v_event.result || jsonb_build_object('replayed', true)");
    expect(migration).toContain("set enabled = p_enabled, revision = v_state.revision + 1, updated_at = p_now");
    expect(migration).not.toMatch(/delete\s+from\s+public\.note_review_states/i);
  });

  it("keeps the database server-only and is included in setup and Site bundling", () => {
    expect(migration).toContain("alter table public.note_review_states enable row level security");
    expect(migration).toContain("alter table public.note_review_events enable row level security");
    expect(migration).toMatch(/revoke all on public\.note_review_states, public\.note_review_events from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.record_note_review_rating_v1[\s\S]*to service_role/i);
    const setup = readFileSync(new URL("../setup.sql", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
    const builder = readFileSync(new URL("../scripts/build-sites-worker.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(setup).toContain(migration.replace(/\r\n/gu, "\n").trim());
    expect(builder).toContain("202610020001_note_review_states.sql");
    expect(readme).toContain("202610020001_note_review_states.sql");
  });
});
