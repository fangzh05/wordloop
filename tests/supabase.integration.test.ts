import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDatabase, resetDatabaseForTests } from "../server/db.js";
import { persistShanbayBook } from "../server/integrations/shanbay/importer.js";
import type { ShanbayWord } from "../server/integrations/shanbay/types.js";
import { recordAttempt } from "../server/services/attempts.js";
import { recordReviewSubmission } from "../server/services/fsrsReviews.js";
import { getLearningContext } from "../server/services/review.js";
import { finishStudySession, getActiveStudySession, makeStudyState, persistStudyState, studySessionSummary } from "../server/services/studySessions.js";
import { getDailyNewWordLimit, prepareDailyNewWords, recordPretestResult, setDailyNewWordLimit } from "../server/services/words.js";

const canRun = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const integrationUser = randomUUID();
const book = { id: `wordloop-integration-${integrationUser}`, name: "WordLoop 集成测试词书", is_current: false };
const days = { one: "2030-01-01", two: "2030-01-02", three: "2030-01-03" };

function sourceWords(prefix: string, count: number): ShanbayWord[] {
  return Array.from({ length: count }, (_, index) => ({
    normalized: `${prefix}${index}`,
    display: `${prefix}${index}`,
    ipa_us: "/test/",
    ipa_uk: null,
    senses: [{ pos: "n.", definition_cn: "集成测试词" }],
    source_state: "unlearned",
    position: index,
  }));
}

async function dailyCount(date: string): Promise<number> {
  const db = getDatabase();
  const { data: imports, error: importError } = await db
    .from("daily_imports")
    .select("id")
    .eq("user_id", integrationUser)
    .eq("import_date", date);
  expect(importError).toBeNull();
  const ids = (imports ?? []).map((row: { id: string }) => row.id);
  if (ids.length === 0) return 0;
  const { data, error } = await db.from("daily_import_words").select("word_id").in("import_id", ids);
  expect(error).toBeNull();
  return new Set((data ?? []).map((row: { word_id: string }) => row.word_id)).size;
}

describe.runIf(canRun)("Supabase persistence", () => {
  afterAll(async () => {
    resetDatabaseForTests();
    process.env.DEV_USER_ID = integrationUser;
    await getDatabase().from("users").delete().eq("id", integrationUser);
    resetDatabaseForTests();
  });

  it("keeps a durable FSRS vocabulary state while daily queues obey the 003 rules", async () => {
    process.env.DEV_USER_ID = integrationUser;
    resetDatabaseForTests();

    await expect(setDailyNewWordLimit(3)).resolves.toMatchObject({ daily_new_word_limit: 3 });
    expect(await getDailyNewWordLimit()).toBe(3);
    await expect(setDailyNewWordLimit(0)).rejects.toThrow();
    await expect(setDailyNewWordLimit(201)).rejects.toThrow();

    const imported = sourceWords("wlqueue", 7);
    await persistShanbayBook(book, imported);

    const firstDay = await prepareDailyNewWords(undefined, undefined, days.one);
    expect(firstDay).toMatchObject({ prepared: 3, added: 3, limit: 3 });
    expect(await dailyCount(days.one)).toBe(3);

    // All three cards remain new. They must be eligible again tomorrow even
    // though they existed in yesterday's daily_import_words rows.
    const secondDay = await prepareDailyNewWords(undefined, undefined, days.two);
    expect(secondDay).toMatchObject({ prepared: 3, added: 3, limit: 3 });
    expect(await dailyCount(days.two)).toBe(3);
    const repeatSecondDay = await prepareDailyNewWords(undefined, undefined, days.two);
    expect(repeatSecondDay).toMatchObject({ prepared: 3, added: 0, limit: 3 });
    expect(await dailyCount(days.two)).toBe(3);

    // Simulate a legacy/manual daily queue. The pool may add only the unused
    // capacity, so it cannot turn an existing 2-word list into 5 words.
    const db = getDatabase();
    const { data: wordRows, error: wordError } = await db
      .from("words")
      .select("id,normalized_word")
      .in("normalized_word", imported.slice(0, 2).map((word) => word.normalized));
    expect(wordError).toBeNull();
    const { data: legacyImport, error: legacyError } = await db
      .from("daily_imports")
      .insert({ user_id: integrationUser, import_date: days.three, source: "legacy_queue", raw_count: 2 })
      .select("id")
      .single();
    expect(legacyError).toBeNull();
    const { error: legacyWordsError } = await db.from("daily_import_words").insert((wordRows ?? []).map((word: { id: string }, position: number) => ({
      import_id: legacyImport!.id, word_id: word.id, position,
    })));
    expect(legacyWordsError).toBeNull();

    const thirdDay = await prepareDailyNewWords(undefined, undefined, days.three);
    expect(thirdDay).toMatchObject({ prepared: 3, added: 1, limit: 3 });
    expect(await dailyCount(days.three)).toBe(3);

    await setDailyNewWordLimit(1);
    const lowered = await prepareDailyNewWords(undefined, undefined, days.three);
    expect(lowered).toMatchObject({ prepared: 3, added: 0, limit: 1 });
    expect(await dailyCount(days.three)).toBe(3);

    await setDailyNewWordLimit(5);
    const raised = await prepareDailyNewWords(undefined, undefined, days.three);
    expect(raised).toMatchObject({ prepared: 5, added: 2, limit: 5 });
    expect(await dailyCount(days.three)).toBe(5);

    const target = imported[0]!.normalized;
    await recordPretestResult({ word: target, result: "unknown", user_answer: "", activity_type: "pretest_cn_to_en" });
    const { data: beforeAttempt, error: beforeError } = await db.from("user_words")
      .select("status,fsrs_reps,fsrs_stability,next_review_at,last_reviewed_at,word:words!inner(normalized_word)")
      .eq("user_id", integrationUser).eq("word.normalized_word", target).single();
    expect(beforeError).toBeNull();
    await recordAttempt({ word: target, activity_type: "sentence", user_answer: "bad answer", is_correct: false, error_layer: "collocation" });
    const { data: afterAttempt, error: afterError } = await db.from("user_words")
      .select("word_id,status,fsrs_reps,fsrs_stability,next_review_at,last_reviewed_at,collocation_error,word:words!inner(normalized_word)")
      .eq("user_id", integrationUser).eq("word.normalized_word", target).single();
    expect(afterError).toBeNull();
    expect(afterAttempt).toMatchObject({ ...(beforeAttempt as Record<string, unknown>), status: "review", collocation_error: true });

    const { error: forceDueError } = await db.from("user_words")
      .update({ next_review_at: "2020-01-01T00:00:00Z" })
      .eq("user_id", integrationUser).eq("word_id", (afterAttempt as { word_id?: string }).word_id ?? "");
    expect(forceDueError).toBeNull();
    await recordReviewSubmission({
      word: target,
      user_answer: "correct retrieval",
      is_correct: true,
      error_layer: "none",
      rating: "good",
    });
    const { count: reviewLogCount, error: reviewLogError } = await db.from("fsrs_review_logs")
      .select("id", { count: "exact", head: true }).eq("user_id", integrationUser);
    expect(reviewLogError).toBeNull();
    expect(reviewLogCount).toBe(2);

    const { data: stateBeforeDuplicate, error: stateBeforeDuplicateError } = await db.from("user_words")
      .select("fsrs_reps,next_review_at")
      .eq("user_id", integrationUser).eq("word_id", (afterAttempt as { word_id?: string }).word_id ?? "").single();
    expect(stateBeforeDuplicateError).toBeNull();
    const { count: attemptsBeforeDuplicate, error: attemptsBeforeDuplicateError } = await db.from("attempts")
      .select("id", { count: "exact", head: true }).eq("user_id", integrationUser);
    expect(attemptsBeforeDuplicateError).toBeNull();
    await expect(recordReviewSubmission({
      word: target,
      user_answer: "stale retrieval",
      is_correct: true,
      error_layer: "none",
      rating: "good",
    })).rejects.toThrow("FSRS card is not due.");
    const { count: attemptsAfterDuplicate, error: attemptsAfterDuplicateError } = await db.from("attempts")
      .select("id", { count: "exact", head: true }).eq("user_id", integrationUser);
    expect(attemptsAfterDuplicateError).toBeNull();
    expect(attemptsAfterDuplicate).toBe(attemptsBeforeDuplicate);
    const { data: stateAfterDuplicate, error: stateAfterDuplicateError } = await db.from("user_words")
      .select("fsrs_reps,next_review_at")
      .eq("user_id", integrationUser).eq("word_id", (afterAttempt as { word_id?: string }).word_id ?? "").single();
    expect(stateAfterDuplicateError).toBeNull();
    expect(stateAfterDuplicate).toEqual(stateBeforeDuplicate);

    const { count: attemptsBeforeReimport, error: attemptsError } = await db.from("attempts")
      .select("id", { count: "exact", head: true }).eq("user_id", integrationUser);
    expect(attemptsError).toBeNull();
    const { data: stateBeforeReimport, error: stateBeforeError } = await db.from("user_words")
      .select("status,fsrs_reps,fsrs_stability,collocation_error,word:words!inner(normalized_word)")
      .eq("user_id", integrationUser).eq("word.normalized_word", target).single();
    expect(stateBeforeError).toBeNull();

    await persistShanbayBook(book, imported);
    const { data: stateAfterReimport, error: stateAfterError } = await db.from("user_words")
      .select("status,fsrs_reps,fsrs_stability,collocation_error,word:words!inner(normalized_word)")
      .eq("user_id", integrationUser).eq("word.normalized_word", target).single();
    const { count: attemptsAfterReimport, error: attemptsAfterError } = await db.from("attempts")
      .select("id", { count: "exact", head: true }).eq("user_id", integrationUser);
    const { count: sourceRows, error: sourceError } = await db.from("word_sources")
      .select("word_id", { count: "exact", head: true }).eq("user_id", integrationUser).eq("source_book_id", book.id);
    expect(stateAfterError).toBeNull();
    expect(attemptsAfterError).toBeNull();
    expect(sourceError).toBeNull();
    expect(stateAfterReimport).toEqual(stateBeforeReimport);
    expect(attemptsAfterReimport).toBe(attemptsBeforeReimport);
    expect(sourceRows).toBe(imported.length);

    // A fresh context call stands in for opening a new ChatGPT conversation.
    const resumed = await getLearningContext();
    expect(resumed.settings.daily_new_word_limit).toBe(5);
    expect(resumed.rolling_review.some((word) => word.word === target)).toBe(true);
  });

  it("persists and restores a self-contained study card in the existing session table", async () => {
    process.env.DEV_USER_ID = integrationUser;
    resetDatabaseForTests();
    const exercise = {
      activity_type: "sentence",
      instruction: "Use the word in a new scene.",
      prompt: "The plantation changed hands after the harvest.",
      multiline: false,
    };
    const explain = makeStudyState({
      date: "2030-01-03",
      widget: "lesson",
      phase: "lesson_explain",
      current_word: "plantation",
      current_index: 0,
      retry_count: 0,
      payload: {
        widget: "lesson",
        mode: "explain",
        word: "plantation",
        ipa: "/plænˈteɪʃən/",
        part_of_speech: "n.",
        meaning_zh: "种植园",
        collocations: [],
        derivations: [],
        example_en: "The plantation changed hands after the harvest.",
        note: "A large farm or estate.",
        exercise,
      },
    });
    const first = await persistStudyState(explain);
    expect(first.id).toBeTruthy();
    expect(studySessionSummary(await getActiveStudySession())).toEqual({
      active: true,
      widget: "lesson",
      phase: "lesson_explain",
      current_word: "plantation",
      current_index: 0,
    });

    const feedback = makeStudyState({
      ...explain,
      phase: "lesson_feedback",
      retry_count: 1,
      payload: {
        widget: "lesson",
        mode: "feedback",
        word: "plantation",
        progress: "1 / 3",
        exercise,
        feedback: { is_correct: false, user_answer: "wrong", reveal_answer: false },
      },
    });
    const second = await persistStudyState(feedback);
    expect(second.id).toBe(first.id);
    const restored = await getActiveStudySession();
    expect(restored?.state).toEqual(feedback);
    await finishStudySession();
    expect(await getActiveStudySession()).toBeNull();
  });
});
