import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDatabase, resetDatabaseForTests } from "../server/db.js";
import { recordAttempt } from "../server/services/attempts.js";
import { getErrorBook, getLearningContext } from "../server/services/review.js";
import { importWords, recordPretestResult } from "../server/services/words.js";
import { recordReviewResult } from "../server/services/fsrsReviews.js";

const canRun = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const integrationUser = randomUUID();

describe.runIf(canRun)("Supabase persistence", () => {
  afterAll(async () => {
    await getDatabase().from("users").delete().eq("id", integrationUser);
  });

  it("keeps imported state and errors across fresh MCP conversation reads", async () => {
    process.env.DEV_USER_ID = integrationUser;
    resetDatabaseForTests();
    const first = await importWords({ words: ["empirical", "subtle", "empirical"], date: "2026-09-13", source: "shanbay" });
    const duplicate = await importWords({ words: ["empirical", "subtle"], date: "2026-09-13", source: "shanbay" });
    expect(first).toMatchObject({ total: 2, new: 2, existing: 0 });
    expect(duplicate).toMatchObject({ total: 2, new: 0, existing: 2 });

    await recordPretestResult({
      word: "empirical",
      result: "unknown",
      user_answer: "",
      activity_type: "pretest_cn_to_en",
    });
    const db = getDatabase();
    const { data: beforeAttempt } = await db.from("user_words")
      .select("fsrs_reps,fsrs_stability,next_review_at,last_reviewed_at,word:words!inner(normalized_word)")
      .eq("user_id", integrationUser).eq("word.normalized_word", "empirical").single();
    await recordAttempt({ word: "empirical", activity_type: "sentence", user_answer: "bad answer", is_correct: false, error_layer: "collocation" });
    const { data: afterAttempt } = await db.from("user_words")
      .select("fsrs_reps,fsrs_stability,next_review_at,last_reviewed_at,word:words!inner(normalized_word)")
      .eq("user_id", integrationUser).eq("word.normalized_word", "empirical").single();
    expect(afterAttempt).toMatchObject(beforeAttempt as Record<string, unknown>);
    await recordReviewResult({ word: "empirical", rating: "again", source: "review", reason: "independent retrieval failed" });
    const { count: reviewLogCount } = await db.from("fsrs_review_logs")
      .select("id", { count: "exact", head: true }).eq("user_id", integrationUser);
    expect(reviewLogCount).toBe(2);
    expect((await getLearningContext()).rolling_review.some((word) => word.word === "empirical")).toBe(true);

    // This second independent read represents opening another ChatGPT conversation.
    const secondConversation = await getLearningContext();
    expect(secondConversation.stats.error_book).toBe(1);
    expect(secondConversation.recent_activity.some((entry) => entry.word === "empirical" && entry.activity_type === "pretest_cn_to_en")).toBe(true);
    expect((await getErrorBook()).words[0]?.errors).toContain("collocation");

    await recordAttempt({ word: "empirical", activity_type: "collocation", user_answer: "repair 1", is_correct: true, error_layer: "collocation" });
    expect((await getErrorBook()).words[0]?.errors).toContain("collocation");
    await recordAttempt({ word: "empirical", activity_type: "collocation", user_answer: "repair 2", is_correct: true, error_layer: "collocation" });
    expect((await getErrorBook()).words).toHaveLength(0);
  });
});
