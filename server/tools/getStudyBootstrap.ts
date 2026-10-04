import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStudyBootstrap } from "../services/studyBootstrap.js";
import { getTodayCompletedLessonWords } from "../services/attempts.js";
import { planLessonQueue } from "../services/exercisePlanner.js";
import { getStudyDate, getActiveStudySession, finishStudySession, makeStudyState, persistStudyState, persistStudyStateIfRevision } from "../services/studySessions.js";
import { getTodayWords } from "../services/words.js";
import { buildLessonWords } from "../services/lessonQueue.js";
import { safeTool } from "./helpers.js";

async function bootstrapWithSavedLessonPlan() {
  const bootstrap = await getStudyBootstrap();
  const active = await getActiveStudySession();
  if (bootstrap.action === "done" && active?.state?.phase === "review_complete" && active.state.flow.relearn_words.length === 0) {
    await finishStudySession(undefined, undefined, { revision: active.updated_at, sessionId: active.id, allowCompletedReview: true });
    return { ...bootstrap, round_complete: true };
  }
  if (bootstrap.action === "resume") {
    if (bootstrap.widget === "lesson" && active?.state?.widget === "lesson" && active.state.payload.plan) {
      return { ...bootstrap, lesson_plan: active.state.payload.plan };
    }
    return bootstrap;
  }
  if (bootstrap.action !== "lesson") return bootstrap;
  const date = bootstrap.date ?? active?.state?.date ?? await getStudyDate();
  const relearnWords = active?.state?.flow.relearn_words ?? [];
  const queue = active?.state?.flow.lesson_words ?? bootstrap.lesson_words ?? buildLessonWords(
    relearnWords,
    await getTodayWords(date),
    await getTodayCompletedLessonWords(),
  );
  if (queue.length < 1) return { action: "done" as const };
  const currentFlow = active?.state?.flow ?? { relearn_words: relearnWords };
  const plans = currentFlow.exercise_plans?.length === queue.length
    ? currentFlow.exercise_plans
    : await planLessonQueue(queue, relearnWords);
  const nextFlow = { ...currentFlow, lesson_words: queue, exercise_plans: plans };
  if (active?.state) {
    await persistStudyStateIfRevision({ ...active.state, flow: nextFlow }, active.updated_at, undefined, undefined, active.id);
  } else {
    const plan = plans[0]!;
    const state = makeStudyState({
      date,
      widget: "lesson",
      phase: "lesson_explain",
      current_word: queue[0]!,
      current_index: 0,
      retry_count: 0,
      flow: nextFlow,
      payload: { widget: "lesson", widget_version: 3, mode: "generation_error", word: queue[0], plan },
    });
    await persistStudyState(state);
  }
  return { ...bootstrap, lesson_words: queue, lesson_plan: plans[0] };
}

export function registerGetStudyBootstrapTool(server: McpServer): void {
  server.registerTool("get_study_bootstrap", {
    title: "Start or resume WordLoop",
    description: "唯一的 WordLoop 学习启动入口：普通 active session 立即恢复；已完成的 pretest 会在同一 study flow 中按 backend 学习队列继续，不会重新 resume pretest；active Lesson phase=lesson_complete 时恢复原题或 backend 标记的单道周期巩固题；无巩固标记时完成 Lesson session。无 active 时先幂等准备今日队列，再按复习、新词预测试、正式学习或完成状态返回。",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safeTool(bootstrapWithSavedLessonPlan));
}
