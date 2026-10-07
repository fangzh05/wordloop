import { describe, expect, it, vi } from "vitest";
import type { StudyState } from "../server/types.js";
import {
  decideLessonConsolidation,
  getLessonCadence,
} from "../server/services/lessonConsolidation.js";
import { consolidationActivityForCursor } from "../server/services/exercisePlanner.js";

function state(input: Partial<StudyState> = {}): StudyState {
  return {
    version: 1,
    date: "2026-09-30",
    widget: "lesson",
    phase: "lesson_complete",
    current_word: "pressure",
    current_index: 1,
    retry_count: 0,
    flow: { relearn_words: [], lesson_words: ["policy", "pressure"] },
    payload: { widget: "lesson", mode: "feedback", feedback: { is_correct: true, reveal_answer: false } },
    ...input,
  };
}

function pendingTask() {
  return {
    kind: "sentence",
    target_words: ["pressure"],
    plan: {
      plan_version: 1,
      plan_id: "10000000-0000-4000-8000-000000000001",
      exercise_id: "10000000-0000-4000-8000-000000000002",
      scope: "consolidation",
      word_id: "10000000-0000-4000-8000-000000000003",
      target_word_ids: ["10000000-0000-4000-8000-000000000003"],
      target_sense: "压力；影响",
      planned_activity_type: "sentence",
      skill_goal: "情境应用目标词",
      error_focus: null,
      skill_ids: ["target_word_application"],
      hint_level: "context",
      estimated_seconds: 120,
      selection_reason: "达到累计完成阈值。",
    },
  };
}

describe("persistent consolidation cadence", () => {
  it("uses the cross-day four-step rotation and always includes sentence practice", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(consolidationActivityForCursor)).toEqual([
      "translation_en_to_cn", "translation_cn_to_en", "translation_en_to_cn", "sentence",
      "translation_en_to_cn", "translation_cn_to_en", "translation_en_to_cn", "sentence",
    ]);
  });

  it("reads one durable pending item and bounded scalar cadence state", async () => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({
      data: { completion_credit: 4, rotation_cursor: 3, pending_task: pendingTask() }, error: null,
    }));
    const db = { from: vi.fn(() => query) };
    await expect(getLessonCadence(db as any, "user")).resolves.toMatchObject({
      completion_credit: 4,
      rotation_cursor: 3,
      pending_task: { kind: "sentence", target_words: ["pressure"] },
    });
    expect(db.from).toHaveBeenCalledWith("user_lesson_cadence");
  });

  it("attaches the saved original plan once and does not recreate cadence from rounds", async () => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: { pending_task: pendingTask(), last_reminder_task_id: null }, error: null }));
    query.update = vi.fn(() => query);
    query.is = vi.fn(async () => ({ error: null }));
    const db = { from: vi.fn(() => query) };
    const result = await decideLessonConsolidation(state(), db as any, "user");
    expect(result.payload).toMatchObject({
      consolidation: true,
      consolidation_kind: "sentence",
      consolidation_status: "pending",
      consolidation_plan: { plan_id: pendingTask().plan.plan_id, exercise_id: pendingTask().plan.exercise_id },
    });
    expect(query.update).toHaveBeenCalledWith({
      last_reminder_task_id: pendingTask().plan.exercise_id,
      updated_at: expect.any(String),
    });
    expect(db.from).toHaveBeenCalledTimes(2);
  });

  it("does not surface a task again after it was already offered", async () => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({
      data: { pending_task: pendingTask(), last_reminder_task_id: pendingTask().plan.exercise_id }, error: null,
    }));
    const db = { from: vi.fn(() => query) };
    const input = state();
    await expect(decideLessonConsolidation(input, db as any, "user")).resolves.toBe(input);
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("uses UUID equality for subsequent reminders, never an invalid IS UUID filter", async () => {
    const previous = "3907fcc9-b3eb-4172-a2a0-f0e8dbf66e3e";
    const read: any = {};
    read.select = vi.fn(() => read);
    read.eq = vi.fn(() => read);
    read.maybeSingle = vi.fn(async () => ({ data: { pending_task: pendingTask(), last_reminder_task_id: previous }, error: null }));
    const write: any = {};
    write.update = vi.fn(() => write);
    write.eq = vi.fn(() => write);
    write.is = vi.fn(() => { throw new Error("PostgREST IS does not accept a UUID"); });
    write.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
    const db = { from: vi.fn().mockReturnValueOnce(read).mockReturnValueOnce(write) };
    const result = await decideLessonConsolidation(state(), db as any, "user");
    expect(result.payload).toMatchObject({ consolidation: true, consolidation_status: "pending" });
    expect(write.eq).toHaveBeenCalledWith("last_reminder_task_id", previous);
    expect(write.is).not.toHaveBeenCalled();
  });

  it("ignores a not-yet-finished Lesson word", async () => {
    const input = state({ phase: "lesson_feedback" });
    const db = { from: vi.fn() };
    await expect(decideLessonConsolidation(input, db as any, "user")).resolves.toBe(input);
    expect(db.from).not.toHaveBeenCalled();
  });
});
