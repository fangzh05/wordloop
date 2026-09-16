import { getAuthenticatedUserId, getDatabase } from "../db.js";
import type { VocabularyItem } from "../types.js";
import { ensureTodayQueue } from "./dailyQueue.js";
import { getReviewSelection, findFirstLearningWord } from "./review.js";
import { getActiveStudySession } from "./studySessions.js";
import { getTodayWords } from "./words.js";
import { perf } from "./perf.js";

export type StudyBootstrapResult =
  | { action: "resume"; widget: "pretest" | "lesson" | "dictation" }
  | { action: "review"; count: number }
  | { action: "pretest"; words: VocabularyItem[] }
  | { action: "lesson"; word: VocabularyItem }
  | { action: "done" };

export async function getStudyBootstrap(): Promise<StudyBootstrapResult> {
  return perf("get_study_bootstrap", async () => {
    const db = getDatabase();
    const userId = getAuthenticatedUserId();

    const active = await getActiveStudySession(db, userId);
    if (active?.state) {
      return { action: "resume", widget: active.state.widget };
    }

    const queue = await ensureTodayQueue(db, userId);

    const review = await getReviewSelection(1, db, userId);
    if (review.rollingReview.length > 0) {
      return { action: "review", count: review.rollingReview.length };
    }

    const todayWords = await getTodayWords(queue.date, db, userId);
    const newWords = todayWords.filter((word) => word.status === "new" && !word.mastered);
    if (newWords.length > 0) {
      return { action: "pretest", words: newWords.slice(0, 6) };
    }

    const lessonWord = findFirstLearningWord(todayWords);
    return lessonWord ? { action: "lesson", word: lessonWord } : { action: "done" };
  });
}
