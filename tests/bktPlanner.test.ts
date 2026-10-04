import { describe, expect, it, vi } from "vitest";
import { planLessonQueue, planLessonRound, type PlannerWord } from "../server/services/exercisePlanner.js";
import { loadBktPlannerSignals } from "../server/services/bktPlanner.js";

const userId = "00000000-0000-4000-8000-000000000001";
const wordId = "00000000-0000-4000-8000-000000000002";
const word: PlannerWord = { word_id: wordId, word: "allocate", target_sense: "分配", part_of_speech: "v.", lesson_profile: "quick_recall", error_focus: null };
const estimate = { skill_id: "verb_object_collocation", p_mastery: .2, evidence_count: 8 };
function database(mode = "active", states = [estimate], failing = "") {
  const calls: string[] = [];
  const audit = vi.fn();
  return { calls, audit, db: { from(table: string) {
    calls.push(table);
    const result = { data: table === "learning_settings" ? { bkt_mode: mode } : table === "user_skill_state" ? states : [], error: table === failing ? { message: "unavailable" } : null };
    const builder: any = { select: () => builder, eq: () => builder, order: () => builder, limit: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result),
      upsert: (rows: unknown) => { audit(rows); return Promise.resolve(result); },
      then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
    return builder;
  } } as any };
}
async function queue(mock: ReturnType<typeof database>, preserve = false) {
  return planLessonQueue([word.word], [], mock.db, userId, { vocabulary_items: [{ word_id: wordId, word: word.word, status: "new", error_layers: [], senses: [{ definition_cn: word.target_sense, pos: "v." }] } as any],
    ...(preserve ? { preserve_existing_activity: { index: 0, activity_type: "exact_cloze" } } : {}) });
}
describe("database-backed BKT selection", () => {
  it.each(["active", "shadow", "off"])("respects %s mode and uses the same planner", async mode => {
    const mock = database(mode);
    const plans = await queue(mock);
    expect(plans[0]?.planned_activity_type).toBe(mode === "active" ? "collocation" : "translation_cn_to_en");
    if (mode === "active") expect(plans[0]?.skill_signals?.[0]?.reason).toBe("bkt_active:fixed-v1");
    if (mode === "off") expect(mock.calls).not.toContain("user_skill_state");
    expect(mock.calls.every(table => ["learning_settings", "user_skill_state", "exercise_submission_events", "tutor_shadow_decisions"].includes(table))).toBe(true);
  });
  it("requires five independent observations and valid probabilities", async () => {
    const mock = database("active", [{ ...estimate, evidence_count: 4 }, { ...estimate, p_mastery: NaN }, { ...estimate, p_mastery: 1.1 }]);
    expect((await loadBktPlannerSignals(mock.db, userId)).signals).toEqual([]);
    expect((await queue(mock))[0]?.planned_activity_type).toBe("translation_cn_to_en");
  });
  it("retains the displayed task when restoring an older session", async () => {
    expect((await queue(database(), true))[0]?.planned_activity_type).toBe("exact_cloze");
  });
  it("falls back on an estimate read error, but keeps active selection if audit storage fails", async () => {
    expect((await queue(database("active", [estimate], "user_skill_state")))[0]?.planned_activity_type).toBe("translation_cn_to_en");
    expect((await queue(database("active", [estimate], "tutor_shadow_decisions")))[0]?.planned_activity_type).toBe("collocation");
  });
  it("preserves error repair, rolling coverage and word applicability", async () => {
    const signals = (await loadBktPlannerSignals(database().db, userId)).signals;
    expect(planLessonRound({ words: [{ ...word, error_focus: "spelling" }], skill_signals: signals })[0]?.planned_activity_type).toBe("word_recall");
    expect(planLessonRound({ words: [word], skill_signals: signals, recent_activities: Array.from({ length: 19 }, () => ({ scope: "lesson", activity_type: "word_recall" })) })[0]?.planned_activity_type).toBe("translation_cn_to_en");
    expect(planLessonRound({ words: [{ ...word, part_of_speech: "n." }], skill_signals: signals })[0]?.planned_activity_type).toBe("translation_cn_to_en");
    const plans = planLessonRound({ words: [word, { ...word, word_id: userId }], skill_signals: signals });
    expect(plans.map(p => p.planned_activity_type)).toEqual(["translation_cn_to_en", "collocation"]);
    expect(plans.map(p => p.word_id)).toEqual([wordId, userId]);
  });
});
