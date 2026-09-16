import { describe, expect, it } from "vitest";
import {
  advanceStudySessionSchema,
  emptyToolArgsSchema,
  getNextLearningWordSchema,
  lessonSubmissionSchema,
  recordAttemptSchema,
  recordPretestResultSchema,
  recordReviewSubmissionSchema,
  REVIEW_SESSION_MAX,
  reviewWidgetPayloadSchema,
  setDailyNewWordLimitSchema,
} from "../shared/toolContracts.js";
import { buildLessonSessionAdvance, buildLessonSubmissionMessage, buildNextLessonRequest } from "../web/src/lesson/LessonWidget.js";
import { buildDailyNewWordLimitRequest } from "../web/src/components/DailyNewWordControl.js";
import { buildPretestActiveSessionRequest, buildPretestResultSubmission, buildPretestSessionAdvance } from "../web/src/pretest/PretestWidget.js";
import { buildReviewAnswerSubmission, buildReviewSubmission, gradeReviewCnToEn } from "../web/src/review/ReviewWidget.js";

const reviewKinds = ["error_repair", "fsrs_due", "both"] as const;
const directions = ["cn_to_en", "en_definition"] as const;

function reviewItem(direction: (typeof directions)[number], review_kind: (typeof reviewKinds)[number]) {
  return { word: "recur", direction, review_kind };
}

describe("Widget to tool contracts", () => {
  it("encodes correct + hard + spelling as the only successful review near-miss form", () => {
    const nearMiss = {
      word: "recur",
      user_answer: "recure",
      is_correct: true,
      error_layer: "spelling" as const,
      rating: "hard" as const,
      direction: "cn_to_en" as const,
    };
    expect(recordReviewSubmissionSchema.parse(nearMiss)).toMatchObject(nearMiss);
    expect(() => recordReviewSubmissionSchema.parse({ ...nearMiss, rating: "good" })).toThrow();
    expect(() => recordReviewSubmissionSchema.parse({ ...nearMiss, direction: "en_definition" })).toThrow();
  });

  it("covers Review correct, near miss, wrong, and 不会 across every route", () => {
    for (const direction of directions) {
      const verdicts = direction === "cn_to_en"
        ? [
          { label: "correct", user_answer: "recur", ...gradeReviewCnToEn("recur", "recur") },
          { label: "spelling near miss", user_answer: "recure", ...gradeReviewCnToEn("recure", "recur") },
          { label: "wrong answer", user_answer: "navigate", ...gradeReviewCnToEn("navigate", "recur") },
        ]
        : [
          { label: "correct", user_answer: "happen again", is_correct: true, rating: "good" as const, error_layer: "none" as const },
          { label: "wrong answer", user_answer: "a different definition", is_correct: false, rating: "again" as const, error_layer: "meaning" as const },
        ];

      for (const review_kind of reviewKinds) {
        const item = reviewItem(direction, review_kind);
        for (const verdict of verdicts) {
          const call = buildReviewSubmission(item, verdict);
          const parsed = call.name === "record_review_submission"
            ? recordReviewSubmissionSchema.parse(call.arguments)
            : recordAttemptSchema.parse(call.arguments);
          const cursor = buildReviewAnswerSubmission(item, verdict.is_correct, 0);
          expect(advanceStudySessionSchema.parse(cursor)).toEqual(cursor);
          expect(parsed, `${direction}/${review_kind}/${verdict.label}`).toMatchObject({
            word: "recur",
            user_answer: verdict.user_answer,
            is_correct: verdict.is_correct,
            error_layer: verdict.is_correct ? verdict.error_layer : verdict.error_layer === "none" ? "meaning" : verdict.error_layer,
            direction,
          });
          expect(call.name).toBe(review_kind === "error_repair" ? "record_attempt" : "record_review_submission");
          if (verdict.label === "spelling near miss") {
            expect(parsed).toMatchObject({ is_correct: true, error_layer: "spelling" });
            if (call.name === "record_review_submission") {
              expect(parsed).toMatchObject({ rating: "hard" });
            } else {
              expect(parsed).not.toHaveProperty("rating");
            }
          }
        }

        const unknownCall = buildReviewSubmission(item, {
          user_answer: "",
          is_correct: false,
          error_layer: "meaning",
          rating: "again",
        });
        const unknownParsed = unknownCall.name === "record_review_submission"
          ? recordReviewSubmissionSchema.parse(unknownCall.arguments)
          : recordAttemptSchema.parse(unknownCall.arguments);
        expect(unknownParsed, `${direction}/${review_kind}/不会`).toMatchObject({
          word: "recur",
          user_answer: "",
          is_correct: false,
          error_layer: "meaning",
          direction,
        });
      }
    }
  });

  it("validates every Pretest result and session transition payload", () => {
    const activeRequest = buildPretestActiveSessionRequest();
    expect(emptyToolArgsSchema.parse(activeRequest)).toEqual(activeRequest);
    for (const direction of directions) {
      for (const [result, answer] of [["known", "recur"], ["uncertain", "recure"], ["unknown", ""]] as const) {
        const payload = buildPretestResultSubmission(
          { word: "recur", direction },
          answer,
          { result, feedback: "测试反馈。" },
        );
        expect(recordPretestResultSchema.parse(payload)).toEqual(payload);
      }
    }
    for (const event of ["pretest_question", "pretest_result", "listen_repeat", "listen_recall", "pretest_complete"] as const) {
      const advance = buildPretestSessionAdvance(event, 1);
      expect(advanceStudySessionSchema.parse(advance)).toEqual(advance);
    }
  });

  it("keeps the server-owned Review payload bounded at 200 cards", () => {
    const items = Array.from({ length: REVIEW_SESSION_MAX }, (_, index) => ({
      word: `word-${index}`,
      meaning_zh: "测试含义",
      direction: "cn_to_en" as const,
      error_layers: [],
      is_due: true,
      review_kind: "fsrs_due" as const,
      next_review_at: "2026-09-16T00:00:00Z",
    }));
    expect(reviewWidgetPayloadSchema.parse({ widget: "review", items, current_index: REVIEW_SESSION_MAX }).items).toHaveLength(REVIEW_SESSION_MAX);
    expect(() => reviewWidgetPayloadSchema.parse({ widget: "review", items: [...items, items[0]] })).toThrow();
  });

  it("validates Lesson Widget submissions and backend-owned navigation", () => {
    const messageInput = { word: "planet", activity_type: "sentence", prompt: "Use planet in a new scene.", answer: "My answer" };
    expect(lessonSubmissionSchema.parse(messageInput)).toEqual(messageInput);
    expect(buildLessonSubmissionMessage({ word: "planet", activityType: "sentence", prompt: messageInput.prompt, answer: "  My answer  " })).toContain("用户答案：My answer");

    for (const event of ["lesson_start_exercise", "lesson_retry"] as const) {
      const advance = buildLessonSessionAdvance(event);
      expect(advanceStudySessionSchema.parse(advance)).toEqual(advance);
    }
    const next = buildNextLessonRequest("planet");
    expect(getNextLearningWordSchema.parse(next)).toEqual(next);
  });

  it("validates the Daily limit Widget request", () => {
    const request = buildDailyNewWordLimitRequest(20);
    expect(setDailyNewWordLimitSchema.parse(request)).toEqual({ limit: 20 });
  });
});
