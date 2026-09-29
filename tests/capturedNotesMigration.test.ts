import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = new URL("../supabase/migrations/20260929120641_captured_notes.sql", import.meta.url);
const migration = readFileSync(migrationPath, "utf8");

describe("captured Notes migration contract", () => {
  it("keeps capture-only SQL away from learning, queue, session, attempt, and FSRS tables", () => {
    const start = migration.indexOf("create or replace function public.create_captured_note_v1");
    const end = migration.indexOf("create or replace function public.list_captured_notes_v1");
    expect(start).toBeGreaterThanOrEqual(0);
    const captureRpc = migration.slice(start, end);
    expect(captureRpc).not.toMatch(/public\.(?:words|user_words|daily_imports|daily_import_words|study_sessions|attempts|fsrs_review_logs)/);
    expect(migration).toContain("unique (user_id, normalized_text)");
    expect(migration).toContain("unique (user_id, idempotency_key)");
  });

  it("only queues a promoted term when the shared user-word helper inserted a new card", () => {
    const start = migration.indexOf("create or replace function public.promote_captured_note_v1");
    const end = migration.indexOf("create or replace function public.captured_notes_schema_v1");
    const promoteRpc = migration.slice(start, end);
    expect(promoteRpc).toContain("public.ensure_user_word_v1(p_user_id, v_note.normalized_text, p_display_text, 'capture', false)");
    expect(promoteRpc).toContain("if v_ensured.inserted then");
    expect(promoteRpc).toContain("where uw.user_id = p_user_id and w.normalized_word = v_note.normalized_text");
    expect(promoteRpc).not.toMatch(/public\.(?:study_sessions|attempts|fsrs_review_logs)/);
  });

  it("enables RLS and limits the new tables and RPCs to the server role", () => {
    expect(migration).toContain("alter table public.captured_notes enable row level security");
    expect(migration).toContain("alter table public.captured_note_occurrences enable row level security");
    expect(migration).not.toMatch(/create policy/i);
    expect(migration).toMatch(/revoke all on public\.captured_notes, public\.captured_note_occurrences from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.promote_captured_note_v1\(uuid, uuid, date, text\) to service_role/i);
  });

  it("includes the migration in setup.sql and the Sites worker bundle", () => {
    const setup = readFileSync(new URL("../setup.sql", import.meta.url), "utf8").replace(/\r\n/gu, "\n").trimEnd();
    const builder = readFileSync(new URL("../scripts/build-sites-worker.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(setup).toContain("create table public.captured_notes (");
    expect(setup).toContain("create or replace function public.captured_notes_schema_v1");
    for (const name of [
      "202609290001_capture_notes.sql",
      "20260929172617_captured_notes_canonical_adapter.sql",
      "20260929172621_analytics_read_models.sql",
      "20260929184221_progress_scheduled_stability_mean.sql",
    ]) {
      const currentMigration = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8").replace(/\r\n/gu, "\n").trim();
      expect(setup).toContain(currentMigration);
      expect(builder).toContain(name);
      expect(readme).toContain(name);
    }
    expect(builder).toContain("20260929120641_captured_notes.sql");
    expect(readme).toContain("20260929120641_captured_notes.sql");
  });
});
