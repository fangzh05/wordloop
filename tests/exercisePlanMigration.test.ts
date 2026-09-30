import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20260930043404_balanced_exercise_plans.sql", import.meta.url), "utf8");
const indexMigration = readFileSync(new URL("../supabase/migrations/20260930043648_exercise_plan_fk_indexes.sql", import.meta.url), "utf8");
const setup = readFileSync(new URL("../setup.sql", import.meta.url), "utf8");
const normalizeLines = (source: string) => source.replace(/\r\n/g, "\n");

describe("balanced exercise plan migration", () => {
  it("keeps setup.sql synchronized with the additive migration", () => {
    const planMarker = "-- Server-owned exercise plans, evidence events, and durable consolidation cadence.";
    const indexMarker = "-- Cover the new foreign keys reported by the post-migration Supabase advisor.";
    expect(setup).toContain(planMarker);
    const normalizedSetup = normalizeLines(setup);
    const normalizedIndexMigration = normalizeLines(indexMigration);
    expect(normalizedSetup).toContain(normalizeLines(migration).trim());
    const index = normalizedSetup.lastIndexOf(indexMarker);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(normalizedSetup.slice(index)).toContain(normalizedIndexMigration.trim());
    const targetMigration = readFileSync(new URL("../supabase/migrations/20260930141500_consolidation_target_attribution.sql", import.meta.url), "utf8");
    expect(normalizedSetup).toContain(normalizeLines(targetMigration).trim());
  });

  it("stores scoped submission and per-skill events outside FSRS with CAS/idempotency", () => {
    expect(migration).toContain("create table if not exists public.exercise_submission_events");
    expect(migration).toContain("create table if not exists public.exercise_skill_evidence");
    expect(migration).toContain("create unique index if not exists attempts_user_submission_unique");
    expect(migration).toContain("primary key (user_id, submission_id)");
    expect(migration).toContain("for update");
    expect(migration).toContain("v_session.updated_at is distinct from p_expected_revision");
    expect(migration).toContain("create table if not exists public.user_lesson_cadence");
    expect(migration).toContain("normalize_attempt_scope_v1");
    expect(migration).toContain("nullif(item->>'word_id','')::uuid");
    expect(migration).not.toContain("coalesce(nullif(item->>'word_id','')::uuid,v_word_id)");
  });

  it("indexes the foreign keys added for planned exercise history", () => {
    expect(indexMigration).toContain("exercise_skill_evidence_word_idx");
    expect(indexMigration).toContain("exercise_submission_events_session_idx");
    expect(indexMigration).toContain("exercise_submission_events_word_idx");
    expect(indexMigration).toContain("lesson_word_completion_credits_session_idx");
    expect(indexMigration).toContain("lesson_word_completion_credits_word_idx");
  });
});
