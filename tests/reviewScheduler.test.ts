import { describe, expect, it } from "vitest";
import { advanceErrorLayerStreak, applyAttemptCounters, isMastered, reviewDelayDays } from "../server/services/reviewScheduler.js";

describe("V1 review policy", () => {
  it("schedules incorrect attempts for tomorrow", () => {
    expect(reviewDelayDays({ isCorrect: false, consecutiveCorrect: 0 })).toBe(1);
  });

  it("records an incorrect attempt by incrementing wrong count and resetting the global streak", () => {
    expect(applyAttemptCounters({ correctCount: 2, wrongCount: 1, consecutiveCorrect: 1 }, false)).toEqual({
      correctCount: 2, wrongCount: 2, consecutiveCorrect: 0,
    });
  });

  it("uses 3, 7, and 14 day correct intervals", () => {
    expect(reviewDelayDays({ isCorrect: true, consecutiveCorrect: 1 })).toBe(3);
    expect(reviewDelayDays({ isCorrect: true, consecutiveCorrect: 2 })).toBe(7);
    expect(reviewDelayDays({ isCorrect: true, consecutiveCorrect: 3 })).toBe(14);
  });

  it("does not clear an error after one correct repair", () => {
    expect(advanceErrorLayerStreak(0, true)).toEqual({ consecutiveCorrect: 1, active: true });
  });

  it("clears that error layer after two consecutive correct repairs", () => {
    expect(advanceErrorLayerStreak(1, true)).toEqual({ consecutiveCorrect: 2, active: false });
  });

  it("resets the layer streak on another incorrect attempt", () => {
    expect(advanceErrorLayerStreak(1, false)).toEqual({ consecutiveCorrect: 0, active: true });
  });

  it("requires counts and no error flags for mastery", () => {
    expect(isMastered({ correctCount: 3, consecutiveCorrect: 2, hasErrors: false })).toBe(true);
    expect(isMastered({ correctCount: 3, consecutiveCorrect: 2, hasErrors: true })).toBe(false);
    expect(isMastered({ correctCount: 2, consecutiveCorrect: 2, hasErrors: false })).toBe(false);
  });
});
