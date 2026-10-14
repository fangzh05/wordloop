import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const learner = "00000000-0000-4000-8000-000000000002";
const otherLearner = "00000000-0000-4000-8000-000000000003";
const owner = "00000000-0000-4000-8000-000000000001";

const userOwnedTables = [
  "attempts", "bkt_updates", "capture_note_legacy_map", "capture_notes", "captured_note_occurrences",
  "captured_notes", "daily_book_targets", "daily_imports", "difficult_sentences", "evidence_gold_labels",
  "exam_book_entitlements", "exercise_skill_evidence", "exercise_submission_events", "family_candidates",
  "family_exposures", "family_micro_sessions", "fsrs_review_logs", "learning_budget_days",
  "learning_budget_events", "learning_settings", "lesson_word_completion_credits", "note_review_events",
  "note_review_states", "skill_evidence_consumption", "study_sessions", "tutor_shadow_decisions",
  "user_book_preferences", "user_lesson_cadence", "user_skill_state", "user_words", "word_sources",
];

async function createFixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE ROLE authenticator NOLOGIN NOINHERIT;
    CREATE FUNCTION auth.user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('wordloop.test_user_id', true), '')::uuid
    $$;
    CREATE TABLE public.users (id uuid PRIMARY KEY);
    CREATE TABLE public.words (id uuid PRIMARY KEY);
    CREATE TABLE public.exam_books (id text PRIMARY KEY, is_public boolean, is_available boolean);
    CREATE TABLE public.exam_book_words (book_id text);
    CREATE TABLE public.exam_definition_sources (exam_id text);
    CREATE TABLE public.source_definition_batches (id text, book_id text);
    CREATE TABLE public.word_source_definitions (book_id text);
    CREATE TABLE public.capture_note_occurrences (note_id uuid);
    CREATE TABLE public.daily_import_words (import_id uuid);
    CREATE TABLE public.difficult_sentence_words (sentence_id uuid);
    CREATE TABLE public.user_word_error_progress (user_word_id uuid);
  `);
  for (const table of userOwnedTables) {
    if (table === "exam_book_entitlements") {
      await db.exec(`CREATE TABLE public.${table} (user_id uuid, book_id text, expires_at timestamptz, third_party_processing_allowed boolean)`);
    } else {
      await db.exec(`CREATE TABLE public.${table} (id uuid, user_id uuid)`);
    }
  }
  return db;
}

describe("Neon data access policies", () => {
  it("applies the security migration and prevents cross-user row access and writes", async () => {
    const db = await createFixture();
    try {
      await db.exec(`
        INSERT INTO public.users (id) VALUES ('${learner}'), ('${otherLearner}');
        INSERT INTO public.user_words (id, user_id) VALUES ('10000000-0000-4000-8000-000000000001', '${learner}'), ('10000000-0000-4000-8000-000000000002', '${otherLearner}');
        INSERT INTO public.daily_imports (id, user_id) VALUES ('20000000-0000-4000-8000-000000000001', '${learner}'), ('20000000-0000-4000-8000-000000000002', '${otherLearner}');
        CREATE FUNCTION public.test_sensitive_words(p_user_id uuid) RETURNS SETOF public.user_words
          LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM public.user_words WHERE user_id = p_user_id $$;
      `);
      const sql = await readFile(new URL("../neon/migrations/0001_data_api_security.sql", import.meta.url), "utf8");
      await db.exec(sql);
      await db.exec(`SELECT set_config('wordloop.test_user_id', '${learner}', false); SET ROLE authenticated;`);

      const visibleWords = await db.query<{ user_id: string }>("SELECT user_id FROM public.user_words ORDER BY user_id");
      expect(visibleWords.rows).toEqual([{ user_id: learner }]);
      const rpcWords = await db.query<{ user_id: string }>(`SELECT user_id FROM public.test_sensitive_words('${otherLearner}')`);
      expect(rpcWords.rows).toEqual([]);
      await expect(db.query(`INSERT INTO public.user_words (id, user_id) VALUES ('10000000-0000-4000-8000-000000000003', '${otherLearner}')`)).rejects.toThrow();
      await expect(db.query(`INSERT INTO public.daily_import_words (import_id) VALUES ('20000000-0000-4000-8000-000000000002')`)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("allows the Worker owner role to create Auth profiles without granting that write to learners", async () => {
    const db = await createFixture();
    try {
      const sql = await readFile(new URL("../neon/migrations/0001_data_api_security.sql", import.meta.url), "utf8");
      await db.exec(sql);
      await db.exec(`SELECT set_config('wordloop.test_user_id', '${owner}', false); SET ROLE authenticated;`);
      await expect(db.query(`INSERT INTO public.users (id) VALUES ('${learner}')`)).rejects.toThrow();
      await db.exec("RESET ROLE; SET ROLE wordloop_admin;");
      await db.query(`INSERT INTO public.users (id) VALUES ('${learner}')`);
      await db.exec("RESET ROLE;");
      const profile = await db.query<{ id: string }>("SELECT id FROM public.users WHERE id = $1", [learner]);
      expect(profile.rows).toEqual([{ id: learner }]);
    } finally {
      await db.close();
    }
  });

  it("allows the Data API authenticator to select the Worker-issued admin role without bypassing RLS", async () => {
    const db = await createFixture();
    try {
      const sql = await readFile(new URL("../neon/migrations/0001_data_api_security.sql", import.meta.url), "utf8");
      await db.exec(sql);
      await db.exec("SET ROLE authenticator; SET ROLE wordloop_admin;");
      const activeRole = await db.query<{ role_name: string }>("SELECT current_user AS role_name");
      expect(activeRole.rows).toEqual([{ role_name: "wordloop_admin" }]);
      await db.exec("RESET ROLE;");
      const adminCanBypassRls = await db.query<{ bypasses_rls: boolean }>(
        "SELECT rolbypassrls AS bypasses_rls FROM pg_roles WHERE rolname = 'wordloop_admin'",
      );
      expect(adminCanBypassRls.rows).toEqual([{ bypasses_rls: false }]);
    } finally {
      await db.close();
    }
  });
});
