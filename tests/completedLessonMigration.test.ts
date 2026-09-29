import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LESSON_ACTIVITY_TYPES } from "../server/services/attempts.js";

const sql = readFileSync(new URL("../supabase/migrations/20260929021548_formal_lesson_history.sql", import.meta.url), "utf8");

function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  if (start < 0) throw new Error(`Migration is missing ${name}`);
  const end = sql.indexOf("$$;", start);
  if (end < 0) throw new Error(`Migration has an unterminated function ${name}`);
  return sql.slice(start, end + 3);
}

describe("formal Lesson history migration", () => {
  it("uses the same activity types for history reads and daily-pool exclusion", () => {
    const readers = functionBody("get_formal_lesson_attempt_words_v1");
    const pool = functionBody("prepare_daily_new_words_v1");
    for (const activityType of LESSON_ACTIVITY_TYPES) {
      expect(readers).toContain(`'${activityType}'`);
      expect(pool).toContain(`'${activityType}'`);
    }
  });

  it("does not classify mastered or previously lessoned cards as new", () => {
    const pool = functionBody("prepare_daily_new_words_v1");
    expect(pool).toContain("uw.status='new'");
    expect(pool).toContain("uw.mastered=false");
    expect(pool).toContain("from attempts a");
    expect(pool).toContain("a.word_id=uw.word_id");
    expect(pool).toContain("and not exists (");
  });
});
