import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/202609300001_balanced_exercise_plans.sql", import.meta.url), "utf8");
const setup = readFileSync(new URL("../setup.sql", import.meta.url), "utf8");

describe("balanced exercise plan migration", () => {
  it("keeps setup.sql synchronized with the additive migration", () => {
    const marker = "-- Server-owned exercise plans, evidence events, and durable consolidation cadence.";
    const index = setup.lastIndexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(setup.slice(index).trim()).toBe(migration.trim());
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
});
