import { describe, expect, it, vi } from "vitest";
import {
  LESSON_WIDGET_VERSION,
  reviewWidgetPayloadSchema,
  type ReviewWidgetItem,
} from "../shared/toolContracts.js";
import type { StudySessionRow, StudyState, VocabularyItem } from "../server/types.js";
import {
  advanceStudyState,
  makeStudyState,
} from "../server/services/studySessions.js";
import {
  buildLessonNavigation,
  buildLessonWords,
} from "../server/services/lessonQueue.js";
import { buildReviewAnswerSubmission } from "../web/src/review/ReviewWidget.js";
import { lessonPayloadSchema } from "../web/src/lesson/LessonWidget.js";

const bootstrapMocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
  getDatabase: vi.fn(() => ({})),
  getActiveStudySession: vi.fn(),
  freezeLessonQueueForSession: vi.fn(),
  normalizeLegacyLessonSession: vi.fn(),
  normalizeStudyStateForRead: vi.fn((state: StudyState) => state),
  ensureTodayQueue: vi.fn(),
  getDueReviewSelection: vi.fn(),
  getFirstSessionLearningWord: vi.fn(),
  findFirstLearningWord: vi.fn(),
  getTodayWords: vi.fn(),
  getVocabularyItemsByWords: vi.fn(),
}));

vi.mock("../server/db.js", () => ({
  getAuthenticatedUserId: bootstrapMocks.getAuthenticatedUserId,
  getDatabase: bootstrapMocks.getDatabase,
}));
vi.mock("../server/services/studySessions.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
  return {
    ...actual,
    getActiveStudySession: bootstrapMocks.getActiveStudySession,
    freezeLessonQueueForSession: bootstrapMocks.freezeLessonQueueForSession,
    normalizeLegacyLessonSession: bootstrapMocks.normalizeLegacyLessonSession,
    normalizeStudyStateForRead: bootstrapMocks.normalizeStudyStateForRead,
  };
});
vi.mock("../server/services/dailyQueue.js", () => ({ ensureTodayQueue: bootstrapMocks.ensureTodayQueue }));
vi.mock("../server/services/review.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/review.js")>("../server/services/review.js");
  return {
    ...actual,
    getDueReviewSelection: bootstrapMocks.getDueReviewSelection,
    getFirstSessionLearningWord: bootstrapMocks.getFirstSessionLearningWord,
    findFirstLearningWord: bootstrapMocks.findFirstLearningWord,
  };
});
vi.mock("../server/services/words.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/words.js")>("../server/services/words.js");
  return {
    ...actual,
    getTodayWords: bootstrapMocks.getTodayWords,
    getVocabularyItemsByWords: bootstrapMocks.getVocabularyItemsByWords,
  };
});

import { getStudyBootstrap } from "../server/services/studyBootstrap.js";

const date = "2026-09-17";

function vocabulary(word: string, status: VocabularyItem["status"]): VocabularyItem {
  return {
    word,
    display_word: word,
    status,
    source: "integration-test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: null,
    error_layers: [],
    fsrs_stability: 0,
    fsrs_difficulty: 0,
    fsrs_scheduled_days: 0,
    fsrs_state: 0,
    senses: [{ pos: "n.", definition_cn: `测试含义 ${word}` }],
  };
}

function reviewItem(word: string): ReviewWidgetItem {
  return {
    word,
    meaning_zh: `测试含义 ${word}`,
    part_of_speech: "n.",
    direction: "cn_to_en",
    error_layers: [],
    is_due: true,
    review_kind: "fsrs_due",
    next_review_at: "2026-09-16T00:00:00Z",
  };
}

function row(state: StudyState): StudySessionRow {
  return {
    id: "integration-session",
    user_id: "00000000-0000-0000-0000-000000000001",
    started_at: `${date}T00:00:00.000Z`,
    ended_at: null,
    new_words_count: 0,
    review_words_count: 0,
    updated_at: `${date}T00:00:00.000Z`,
    state,
  };
}

function explainPayload(word: string, index: number, lessonWords: string[]) {
  return lessonPayloadSchema.parse({
    widget: "lesson",
    widget_version: LESSON_WIDGET_VERSION,
    mode: "explain",
    phase: "lesson_explain",
    current_index: index,
    word,
    progress: `${index + 1} / ${lessonWords.length}`,
    ipa: "/test/",
    part_of_speech: "v.",
    meaning_zh: `测试含义 ${word}`,
    collocations: [],
    derivations: [],
    example_en: `A separate scene demonstrates ${word}.`,
    note: "集成测试讲解。",
    exercise: {
      activity_type: "sentence",
      instruction: `Use ${word} in a new scene.`,
      prompt: `Write a sentence with ${word}.`,
      multiline: false,
    },
    session_meta: { source: "integration" },
  });
}

function feedbackPayload(word: string, index: number, lessonWords: string[]) {
  return lessonPayloadSchema.parse({
    widget: "lesson",
    widget_version: LESSON_WIDGET_VERSION,
    mode: "feedback",
    phase: "lesson_feedback",
    current_index: index,
    word,
    progress: `${index + 1} / ${lessonWords.length}`,
    navigation: buildLessonNavigation(lessonWords, index, word),
    exercise: {
      activity_type: "sentence",
      instruction: `Use ${word} in a new scene.`,
      prompt: `Write a sentence with ${word}.`,
      multiline: false,
    },
    feedback: {
      is_correct: true,
      user_answer: `The test answer uses ${word}.`,
      reveal_answer: false,
    },
    progress_meta: { source: "integration" },
  });
}

describe("complete WordLoop study flow", () => {
  it("keeps one Review -> Pretest/listening -> frozen Lesson -> Round Complete chain", async () => {
    let active: StudySessionRow | null = null;
    const pretestWords = [
      vocabulary("c", "new"),
      vocabulary("d", "new"),
      vocabulary("e", "new"),
    ];
    const lessonWordsFromResults = [
      vocabulary("c", "known"),
      vocabulary("d", "unknown"),
      vocabulary("e", "uncertain"),
    ];
    bootstrapMocks.getActiveStudySession.mockImplementation(async () => active);
    bootstrapMocks.ensureTodayQueue.mockResolvedValue({ date, prepared: 3, added: 3 });
    bootstrapMocks.getDueReviewSelection.mockResolvedValue({
      rollingReview: [vocabulary("a", "review"), vocabulary("b", "review")],
      oldRandomReview: [],
    });
    bootstrapMocks.getTodayWords.mockResolvedValue(pretestWords);
    bootstrapMocks.getVocabularyItemsByWords.mockImplementation(async (words: string[]) => words.map((word) => vocabulary(word, "unknown")));
    bootstrapMocks.freezeLessonQueueForSession.mockImplementation(async (session: StudySessionRow, words: VocabularyItem[]) => {
      const lesson_words = buildLessonWords(session.state!.flow.relearn_words, words);
      active = { ...session, state: { ...session.state!, flow: { ...session.state!.flow, lesson_words } } };
      return active;
    });
    bootstrapMocks.normalizeLegacyLessonSession.mockImplementation(async (session: StudySessionRow) => session);

    const start = await getStudyBootstrap();
    expect(start).toEqual({ action: "review", count: 2 });

    const reviewPayload = reviewWidgetPayloadSchema.parse({
      widget: "review",
      items: [reviewItem("a"), reviewItem("b")],
      title: "复习",
    });
    let state = makeStudyState({
      date,
      widget: "review",
      phase: "review",
      current_word: "a",
      current_index: 0,
      retry_count: 0,
      flow: { relearn_words: [] },
      payload: reviewPayload,
    });
    state = advanceStudyState(state, "review_answer", 0, buildReviewAnswerSubmission({ word: "a" }, true, 0));
    state = advanceStudyState(state, "review_answer", 1, buildReviewAnswerSubmission({ word: "b" }, false, 1));
    expect(state).toMatchObject({ phase: "review_complete", current_word: null, current_index: 2, flow: { relearn_words: ["b"] } });
    active = row(state);

    const nextPretest = await getStudyBootstrap();
    expect(nextPretest).toMatchObject({ action: "pretest", words: pretestWords });

    const pretestItems = [
      { word: "c" },
      { word: "d" },
      { word: "e" },
    ];
    state = makeStudyState({
      date,
      widget: "pretest",
      phase: "pretest",
      current_word: "c",
      current_index: 0,
      retry_count: 0,
      flow: state.flow,
      payload: { widget: "pretest", items: pretestItems, results: [
        { word: "c", result: "known" },
        { word: "d", result: "unknown" },
        { word: "e", result: "uncertain" },
      ] },
    });
    state = advanceStudyState(state, "pretest_result", 0);
    state = advanceStudyState(state, "pretest_question", 1);
    state = advanceStudyState(state, "pretest_result", 1);
    state = advanceStudyState(state, "pretest_question", 2);
    state = advanceStudyState(state, "pretest_result", 2);
    state = advanceStudyState(state, "listen_repeat", 1);
    state = advanceStudyState(state, "listen_recall", 1);
    expect(state).toMatchObject({ phase: "listen_recall", current_word: "d", current_index: 1 });
    // D is recalled incorrectly, but listening recall still advances to E.
    state = advanceStudyState(state, "listen_repeat", 2);
    state = advanceStudyState(state, "listen_recall", 2);
    expect(state).toMatchObject({ phase: "listen_recall", current_word: "e", current_index: 2 });
    state = advanceStudyState(state, "pretest_complete", 3);
    expect(state).toMatchObject({ phase: "pretest_complete", current_word: null, current_index: 3 });

    active = row(state);
    bootstrapMocks.getTodayWords.mockResolvedValue(lessonWordsFromResults);
    const nextLesson = await getStudyBootstrap();
    expect(nextLesson).toMatchObject({ action: "lesson", word: { word: "b" } });
    const lessonWords = buildLessonWords(state.flow.relearn_words, lessonWordsFromResults);
    expect(lessonWords).toEqual(["b", "d", "e"]);
    expect(active.state?.flow.lesson_words).toEqual(lessonWords);

    const visited: string[] = [];
    for (const [index, word] of lessonWords.entries()) {
      visited.push(word);
      const navigation = buildLessonNavigation(lessonWords, index, word);
      const explain = explainPayload(word, index, lessonWords);
      expect(explain).toMatchObject({ mode: "explain", word });
      const exercise = advanceStudyState(makeStudyState({
        date,
        widget: "lesson",
        phase: "lesson_explain",
        current_word: word,
        current_index: index,
        retry_count: 0,
        flow: { relearn_words: ["b"], lesson_words: lessonWords },
        payload: explain,
      }), "lesson_start_exercise");
      expect(exercise).toMatchObject({ phase: "lesson_exercise", current_word: word, current_index: index });

      const feedback = feedbackPayload(word, index, lessonWords);
      expect(feedback.navigation).toEqual(navigation);
      const feedbackState = makeStudyState({
        date,
        widget: "lesson",
        phase: "lesson_feedback",
        current_word: word,
        current_index: index,
        retry_count: 0,
        flow: { relearn_words: ["b"], lesson_words: lessonWords },
        payload: feedback,
      });
      if (navigation.action === "next_word") {
        expect(navigation.next_word).toBe(lessonWords[index + 1]);
      } else {
        expect(index).toBe(lessonWords.length - 1);
        const completed = advanceStudyState(feedbackState, "lesson_complete");
        expect(completed).toMatchObject({ phase: "lesson_complete", current_word: "e", current_index: 2 });
        expect(advanceStudyState(completed, "lesson_complete")).toBe(completed);
      }
    }

    expect(visited).toEqual(["b", "d", "e"]);
    expect(bootstrapMocks.getDueReviewSelection).toHaveBeenCalledOnce();
    expect(bootstrapMocks.getActiveStudySession).toHaveBeenCalledTimes(3);
  });
});
