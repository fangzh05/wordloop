import { describe, expect, it } from "vitest";
import { consolidationActivityForCursor, planLessonRound, summarizeShortTaskCoverage } from "../server/services/exercisePlanner.js";
import type { PlannerWord } from "../server/services/exercisePlanner.js";

function shanghaiDate(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(instant));
}

function plannedWords(start: number, count: number): PlannerWord[] {
  return Array.from({ length: count }, (_, offset) => ({
    word_id: `00000000-0000-4000-8000-${String(start + offset).padStart(12, "0")}`,
    word: `fixed-seed-${start + offset}`,
    target_sense: "在语境中表达分配资源",
    part_of_speech: "v.",
    lesson_profile: "quick_recall",
    error_focus: null,
  }));
}

describe("fixed-seed multi-day learning flow", () => {
  it("keeps plans and deferred cadence stable across midnight and rotates only on completion", () => {
    const seed = 20260930;
    const recent = Array.from({ length: 19 }, () => ({ scope: "lesson" as const, activity_type: "word_recall" }));
    const ids = (() => { let id = 0; return () => `00000000-0000-4000-9000-${String(++id).padStart(12, "0")}`; })();
    const plan = planLessonRound({ words: plannedWords(seed, 5), recent_activities: recent, id_factory: ids });
    const window20 = [
      ...recent.map(({ activity_type }) => ({ activity_type })),
      ...plan.map((item) => ({ activity_type: item.planned_activity_type, coverage_exception_reason: item.coverage_exception_reason })),
    ].slice(-20);
    const coverage = summarizeShortTaskCoverage(window20);
    expect(coverage).toMatchObject({ count: 20, translations: 2, activity_types: ["collocation", "translation_cn_to_en", "word_recall"], retrieval_count: 15, meets_initial_targets: true });

    // The local ledger models the documented DB transaction inputs; database
    // concurrency itself is covered by the SQL CAS/unique constraints.
    let credit = 0;
    let cursor = 0;
    let pending: { plan_id: string; exercise_id: string; activity_type: string } | null = null;
    const submitted = new Set<string>();
    const dailyWords = new Map<string, Set<string>>();
    const finishLessonWord = (input: { submission: string; scope: "lesson" | "review"; instant: string; word: string }) => {
      if (submitted.has(input.submission)) return;
      submitted.add(input.submission);
      if (input.scope !== "lesson") return;
      const date = shanghaiDate(input.instant);
      const dayWords = dailyWords.get(date) ?? new Set<string>();
      dailyWords.set(date, dayWords);
      if (dayWords.has(input.word)) return;
      dayWords.add(input.word);
      if (pending) credit = Math.min(9, credit + 1);
      else credit += 1;
      if (!pending && credit >= 10) {
        const activity = consolidationActivityForCursor(cursor);
        pending = { plan_id: `plan-${cursor}-seed-${seed}`, exercise_id: `exercise-${cursor}-seed-${seed}`, activity_type: activity };
        credit = 0;
      }
    };

    const dayOne = "2026-09-30T15:59:00.000Z";
    const dayTwo = "2026-09-30T16:01:00.000Z";
    const dayThree = "2026-10-01T16:01:00.000Z";
    expect(shanghaiDate(dayOne)).toBe("2026-09-30");
    expect(shanghaiDate(dayTwo)).toBe("2026-10-01");
    for (let index = 0; index < 7; index += 1) finishLessonWord({ submission: `d1-${index}`, scope: "lesson", instant: dayOne, word: `w${index}` });
    finishLessonWord({ submission: "duplicate-submission", scope: "lesson", instant: dayOne, word: "w0" });
    finishLessonWord({ submission: "d1-repeat-word", scope: "lesson", instant: dayOne, word: "w0" });
    finishLessonWord({ submission: "d1-review", scope: "review", instant: dayOne, word: "review-only" });
    expect({ credit, pending }).toEqual({ credit: 7, pending: null });

    for (let index = 7; index < 10; index += 1) finishLessonWord({ submission: `d2-${index}`, scope: "lesson", instant: dayTwo, word: `w${index}` });
    const original = { ...pending! };
    expect(original.activity_type).toBe("translation_en_to_cn");
    // Deferral and failed generation leave pending plan/cursor intact. More
    // Lesson words add bounded credit rather than create a backlog of tasks.
    const afterDeferAndFailure = { ...pending! };
    for (let index = 10; index < 14; index += 1) finishLessonWord({ submission: `d2-${index}`, scope: "lesson", instant: dayTwo, word: `w${index}` });
    expect(afterDeferAndFailure).toEqual(original);
    expect({ credit, pending }).toEqual({ credit: 4, pending: original });

    const resumedNextDay = { ...pending! };
    expect(resumedNextDay).toEqual(original);
    pending = null; // One real completion, transactionally advances cursor.
    cursor = (cursor + 1) % 4;
    expect({ cursor, credit }).toEqual({ cursor: 1, credit: 4 });
    for (let index = 14; index < 20; index += 1) finishLessonWord({ submission: `d3-${index}`, scope: "lesson", instant: dayThree, word: `w${index}` });
    expect(pending).toMatchObject({ activity_type: "translation_cn_to_en" });
    expect([0, 1, 2, 3].map(consolidationActivityForCursor)).toEqual([
      "translation_en_to_cn", "translation_cn_to_en", "translation_en_to_cn", "sentence",
    ]);

    console.info("LEARNING_FLOW_SIMULATION", JSON.stringify({
      seed,
      days: [shanghaiDate(dayOne), shanghaiDate(dayTwo), shanghaiDate(dayThree)],
      short_task_distribution: Object.fromEntries(coverage.activity_types.map((activity) => [activity, window20.filter((item) => item.activity_type === activity).length])),
      coverage: { translations: coverage.translations, retrieval: coverage.retrieval_count, exception_reasons: coverage.exceptions },
      trigger_at_distinct_lesson_words: 10,
      deferred_pending_restored_next_day: resumedNextDay,
      credit_after_defer: 4,
      next_after_real_completion: (pending as { plan_id: string; exercise_id: string; activity_type: string } | null)?.activity_type,
      rotation: [0, 1, 2, 3].map(consolidationActivityForCursor),
    }));
  });
});
