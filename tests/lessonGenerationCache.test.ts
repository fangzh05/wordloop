import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { lessonExercisePlanSchema } from "../shared/toolContracts.js";
import {
  lessonGenerationCacheKey,
  mergeAnkiMaterial,
  PrivateLessonCacheReadError,
  PERSONAL_KAOYAN_SET_ID,
  PRIVATE_UNION_SOURCE_VERSION,
} from "../server/services/lessonGenerationCache.js";
import type { LessonGeneration } from "../server/services/deepseek.js";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const wordA = "10000000-0000-4000-8000-000000000001";
const wordB = "10000000-0000-4000-8000-000000000002";

describe("private Lesson cache read retries", () => {
  it("retries transient database failures and never retries permission failures", () => {
    expect(new PrivateLessonCacheReadError({ status: 503, message: "temporarily unavailable" }).retryable).toBe(true);
    expect(new PrivateLessonCacheReadError({ message: "permission denied by row level security" }).retryable).toBe(false);
    expect(new PrivateLessonCacheReadError({ code: "42501", message: "forbidden" }).retryable).toBe(false);
  });
});

function plan(overrides: Record<string, unknown> = {}) {
  return lessonExercisePlanSchema.parse({
    plan_version: 1,
    plan_id: "20000000-0000-4000-8000-000000000001",
    exercise_id: "30000000-0000-4000-8000-000000000001",
    scope: "lesson",
    word_id: wordA,
    target_word_ids: [wordA],
    target_sense: "分配；拨给",
    planned_activity_type: "word_recall",
    skill_goal: "从当前中文义项提取对应英文词",
    error_focus: null,
    skill_ids: ["target_sense_retrieval"],
    skill_signals: [],
    hint_level: "none",
    estimated_seconds: 20,
    selection_reason: "test plan",
    ...overrides,
  });
}

function lesson(overrides: Partial<LessonGeneration> = {}): LessonGeneration {
  return {
    ipa: "/ˈæləkeɪt/",
    part_of_speech: "v.",
    meaning_zh: "分配；拨给",
    collocations: ["allocate resources：分配资源"],
    derivations: ["allocation：分配；拨款"],
    example_en: "The committee allocated additional funds to improve access to public libraries.",
    example_zh: "委员会拨出额外资金，以改善公众使用图书馆的便利性。",
    note: "allocate something to somebody or something。",
    exercise: {
      activity_type: "word_recall",
      instruction: "根据中文释义写出英文单词。",
      prompt: "分配；拨给",
      multiline: false,
      accepted_answers: ["allocate"],
    },
    ...overrides,
  };
}

describe("private Lesson cache keys and Anki merge", () => {
  it("ignores random plan ids but changes for profile, error, sense, user and activity", async () => {
    const base = {
      userId: userA,
      wordId: wordA,
      word: "allocate",
      meaningZh: "分配；拨给",
      partOfSpeech: "v.",
      lessonProfile: "quick_recall" as const,
      errorFocus: null,
      plan: plan(),
    };
    const first = await lessonGenerationCacheKey(base, null);
    const privateUnionSourceKey = await lessonGenerationCacheKey(base, null, PRIVATE_UNION_SOURCE_VERSION);
    expect(privateUnionSourceKey.cacheKey).not.toBe(first.cacheKey);
    const newPlanIds = await lessonGenerationCacheKey({
      ...base,
      plan: plan({ plan_id: "20000000-0000-4000-8000-000000000002", exercise_id: "30000000-0000-4000-8000-000000000002" }),
    }, null);
    expect(first.cacheKey).toBe(newPlanIds.cacheKey);
    expect((await lessonGenerationCacheKey({
      ...base,
      plan: plan({ selection_reason: "另一个规划原因", estimated_seconds: 90 }),
    }, null)).cacheKey).toBe(first.cacheKey);
    expect((await lessonGenerationCacheKey({
      ...base,
      plan: plan({ skill_goal: "修复拼写错误" }),
    }, null)).cacheKey).not.toBe(first.cacheKey);
    expect((await lessonGenerationCacheKey({ ...base, lessonProfile: "reinforce" }, null)).cacheKey).not.toBe(first.cacheKey);
    expect((await lessonGenerationCacheKey({ ...base, errorFocus: "spelling", plan: plan({ error_focus: "spelling" }) }, null)).cacheKey).not.toBe(first.cacheKey);
    expect((await lessonGenerationCacheKey({ ...base, userId: userB }, null)).cacheKey).not.toBe(first.cacheKey);
    expect((await lessonGenerationCacheKey({ ...base, plan: plan({ target_sense: "分配资源" }) }, null)).cacheKey).not.toBe(first.cacheKey);
    expect((await lessonGenerationCacheKey({ ...base, plan: plan({ planned_activity_type: "exact_cloze" }) }, null)).cacheKey).not.toBe(first.cacheKey);
    expect(PERSONAL_KAOYAN_SET_ID).toBe("kaoyan-personal-union-v1");
  });

  it("keeps valid Anki fields and rejects sense-specific reuse when the Anki sense differs", () => {
    const anki = {
      word: "allocate",
      meaning_zh: "分配；拨给",
      part_of_speech: "v.",
      ipa: "/ˈæləkeɪt/",
      collocations: ["allocate resources：分配资源"],
      derivations: ["allocation：分配；拨款"],
      example_en: "The committee allocated additional funds to improve access to public libraries.",
      example_zh: "委员会拨出额外资金，以改善公众使用图书馆的便利性。",
      source_fields: ["Word", "Meaning", "Examples"],
    };
    const reused = mergeAnkiMaterial(lesson({ ipa: "/wrong/", example_en: "Generated alternative sentence for the lesson." }), anki, "分配；拨给");
    expect(reused.usedAnki).toBe(true);
    expect(reused.lesson.ipa).toBe(anki.ipa);
    expect(reused.lesson.example_en).toBe(anki.example_en);
    const unrelated = mergeAnkiMaterial(lesson(), { ...anki, meaning_zh: "拨款" }, "分配；拨给");
    expect(unrelated.lesson.meaning_zh).toBe("分配；拨给");
    expect(unrelated.lesson.example_en).toBe(lesson().example_en);
  });
});

describe("lesson_generation_cache Neon policies", () => {
  it("isolates cache reads and writes to the current personal-union user and member words", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anonymous NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE wordloop_admin NOLOGIN NOBYPASSRLS;
        CREATE SCHEMA wordloop_private;
        CREATE FUNCTION public.wordloop_authenticated_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT NULLIF(current_setting('wordloop.test_user_id', true), '')::uuid
        $$;
        GRANT EXECUTE ON FUNCTION public.wordloop_authenticated_user_id() TO authenticated;
        CREATE FUNCTION wordloop_private.assert_current_user_row() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
            RAISE EXCEPTION 'user scope denied';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TABLE public.users (id uuid PRIMARY KEY);
        CREATE TABLE public.words (id uuid PRIMARY KEY);
        CREATE TABLE public.word_sources (user_id uuid, word_id uuid, source_book_id text);
        ALTER TABLE public.word_sources ENABLE ROW LEVEL SECURITY;
        CREATE POLICY source_self_read ON public.word_sources FOR SELECT TO authenticated
          USING (user_id = public.wordloop_authenticated_user_id());
        GRANT SELECT ON public.word_sources TO authenticated;
        INSERT INTO public.users (id) VALUES ('${userA}'), ('${userB}');
        INSERT INTO public.words (id) VALUES ('${wordA}'), ('${wordB}');
        INSERT INTO public.word_sources VALUES
          ('${userA}','${wordA}','ougkp'), ('${userA}','${wordA}','athgc'),
          ('${userB}','${wordA}','ougkp'), ('${userB}','${wordA}','athgc');
      `);
      const migration = await readFile(new URL("../neon/migrations/0010_private_lesson_generation_cache.sql", import.meta.url), "utf8");
      await db.exec(migration);
      const versionedIdempotency = await readFile(new URL("../neon/migrations/0011_versioned_lesson_generation_cache_idempotency.sql", import.meta.url), "utf8");
      await db.exec(versionedIdempotency);
      await db.exec(`SELECT set_config('wordloop.test_user_id','${userA}',false); SET ROLE authenticated;`);
      await db.query(`
        INSERT INTO public.lesson_generation_cache (
          user_id,private_set_id,word_id,cache_kind,cache_key,payload_hash,sense_fingerprint,
          target_sense,content_version,prompt_version,source_version,source_kind,generation_method,
          quality_status,is_valid
        ) VALUES (
          $1,$2,$3,'materials',repeat('a',64),repeat('b',64),repeat('c',64),
          '分配；拨给','lesson-generation-v3','lesson-generation-prompt-v3','anki-test','anki','apkg_import',
          'partial',false
        )`, [userA, PERSONAL_KAOYAN_SET_ID, wordA]);
      const visible = await db.query<{ user_id: string }>("SELECT user_id FROM public.lesson_generation_cache");
      expect(visible.rows).toEqual([{ user_id: userA }]);
      await db.query(`
        INSERT INTO public.lesson_generation_cache (
          user_id,private_set_id,word_id,cache_kind,cache_key,payload_hash,sense_fingerprint,
          target_sense,content_version,prompt_version,source_version,source_kind,generation_method,
          quality_status,is_valid
        ) VALUES (
          $1,$2,$3,'materials',repeat('a',64),repeat('b',64),repeat('c',64),
          '分配；拨给','lesson-generation-v4','lesson-generation-prompt-v4','anki-test','anki','apkg_import',
          'partial',false
        )`, [userA, PERSONAL_KAOYAN_SET_ID, wordA]);
      const versions = await db.query<{ content_version: string }>(
        "SELECT content_version FROM public.lesson_generation_cache WHERE word_id = $1 ORDER BY content_version",
        [wordA],
      );
      expect(versions.rows.map((row) => row.content_version)).toEqual(["lesson-generation-v3", "lesson-generation-v4"]);
      await expect(db.query(`INSERT INTO public.lesson_generation_cache (
        user_id,private_set_id,word_id,cache_kind,cache_key,payload_hash,sense_fingerprint,
        target_sense,content_version,prompt_version,source_version,source_kind,generation_method,
        quality_status,is_valid
      ) VALUES ($1,$2,$3,'materials',repeat('d',64),repeat('e',64),repeat('f',64),'分配','v1','p1','anki-test','anki','apkg_import','partial',false)`, [userA, PERSONAL_KAOYAN_SET_ID, wordB])).rejects.toThrow();
      await expect(db.query(`INSERT INTO public.lesson_generation_cache (
        user_id,private_set_id,word_id,cache_kind,cache_key,payload_hash,sense_fingerprint,
        target_sense,content_version,prompt_version,source_version,source_kind,generation_method,
        quality_status,is_valid
      ) VALUES ($1,'other-private-set',$2,'materials',repeat('d',64),repeat('e',64),repeat('f',64),'分配','v1','p1','anki-test','anki','apkg_import','partial',false)`, [userA, wordA])).rejects.toThrow();
      await db.exec(`RESET ROLE; SELECT set_config('wordloop.test_user_id','${userB}',false); SET ROLE authenticated;`);
      const otherUserRows = await db.query("SELECT * FROM public.lesson_generation_cache");
      expect(otherUserRows.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
