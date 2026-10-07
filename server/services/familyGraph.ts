import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase, getAuthenticatedUserId } from "../db.js";
import type { UserWordRow } from "../types.js";
import type { FamilyGraph, FamilyNode, LexicalRelation, FamilyLesson, FamilySessionView } from "../../shared/familyContracts.js";
import { localFamilyGraph, normalizeLemma, selectFamilyCandidate, type FamilyExposure } from "./familyPolicy.js";
import { buildFamilyLesson } from "./familyLesson.js";
import { scheduleReview, cardToDatabase, reviewLogToDatabase } from "./fsrsScheduler.js";

export class FamilyServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(error: { message?: string; code?: string } | null): void {
  if (!error) return;
  const code = error.message?.match(/FAMILY_[A-Z_]+/)?.[0];
  if (code) throw new FamilyServiceError(code.includes("NOT_FOUND") ? 404 : 409, code,
    code === "FAMILY_BUDGET_REACHED" ? "今日学习预算已用完。" : code === "FAMILY_SESSION_PENDING" ? "请先完成已开始的词族短练习。" : "当前学习状态已变化，请重新打开词族；系统会保留学习间隔。");
  if (["42P01", "42883", "PGRST202"].includes(error.code ?? "")) throw new FamilyServiceError(503, "FAMILY_SCHEMA_REQUIRED", "词族学习数据尚未安装。");
  throw new FamilyServiceError(500, "FAMILY_QUERY_FAILED", "词族暂时不可用，请稍后重试。");
}
interface GraphResult { center_id: string; nodes: FamilyNode[]; edges: LexicalRelation[]; exposures: FamilyExposure[]; truncated: boolean; has_developing_member: boolean }
export async function getFamilyContext(lexeme: string, db: SupabaseClient = getDatabase(), userId = getAuthenticatedUserId()) {
  const r = await db.rpc("get_family_graph_v1", { p_user_id: userId, p_lexeme: normalizeLemma(lexeme), p_limit: 24 });
  fail(r.error);
  if (!r.data) throw new FamilyServiceError(404, "FAMILY_NOT_FOUND", "这个词暂时没有已核验的词族数据。");
  const raw = r.data as GraphResult;
  const nodes = raw.nodes.map((node) => ({ ...node, priority: node.utility_score * (node.user_state ? 0.6 : 1),
    reason: node.lexeme_id === raw.center_id ? "当前词" : `${node.lemma} 与当前词存在已核验的形态派生关系。` }));
  const center = nodes.find((n) => n.lexeme_id === raw.center_id);
  if (!center) throw new FamilyServiceError(500, "FAMILY_QUERY_FAILED", "词族中心数据无法读取。");
  const graph = localFamilyGraph(center, nodes, raw.edges);
  graph.truncated ||= raw.truncated;
  graph.has_developing_member = raw.has_developing_member;
  return { graph, exposures: raw.exposures };
}
export async function getFamilyGraph(lexeme: string): Promise<FamilyGraph> { return (await getFamilyContext(lexeme)).graph; }
export async function getFamilyCandidate(lexeme: string) {
  const { graph, exposures } = await getFamilyContext(lexeme);
  return selectFamilyCandidate(graph, exposures, new Date());
}
export async function addFamilyCandidate(lexemeId: string) {
  const db = getDatabase(), userId = getAuthenticatedUserId();
  const term = await db.from("lexical_lexemes").select("lexeme_id").eq("lexeme_id", lexemeId).maybeSingle();
  fail(term.error);
  if (!term.data) throw new FamilyServiceError(404, "FAMILY_NOT_FOUND", "这个词条不存在。");
  const r = await db.from("family_candidates").upsert({ user_id: userId, lexeme_id: lexemeId }, { onConflict: "user_id,lexeme_id", ignoreDuplicates: true });
  fail(r.error);
  return { saved: true, message: "已加入未来候选，尚未创建学习卡。" };
}
interface MicroRow {
  id: string; lesson: FamilyLesson; index: number; completed: boolean; activated: boolean;
  feedback: FamilySessionView["feedback"];
}
export function familySessionView(row: MicroRow): FamilySessionView {
  const step = row.lesson.steps[row.index];
  // Never send future answers/explanations to the browser.
  return { id: row.id, base: row.lesson.base_id.split(":")[1]!, derivative: row.lesson.target_id?.split(":")[1] ?? null,
    stage: row.lesson.stage, explanation: row.index === 0 ? row.lesson.explanation : "根据词性和语境完成短练习。",
    index: row.index, total: row.lesson.steps.length, completed: row.completed, activated: row.activated,
    step: step ? { target_id: step.target_id, activity_type: step.activity_type, error_layer: step.error_layer, prompt: step.prompt } : null,
    ...(row.feedback ? { feedback: row.feedback } : {}) };
}
export async function getFamilyMicroSession() {
  const db = getDatabase(), userId = getAuthenticatedUserId();
  const active = await db.from("study_sessions").select("id").eq("user_id", userId).is("ended_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle();
  fail(active.error);
  if (!active.data) return null;
  const r = await db.from("family_micro_sessions").select("*").eq("user_id", userId).eq("study_session_id", active.data.id).eq("completed", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
  fail(r.error);
  return r.data ? familySessionView(r.data as MicroRow) : null;
}
export async function startFamilyMicroSession(lexeme: string, requestId: string) {
  const db = getDatabase(), userId = getAuthenticatedUserId();
  const existing = await db.from("family_micro_sessions").select("*").eq("user_id", userId).eq("request_id", requestId).maybeSingle();
  fail(existing.error);
  if (existing.data) return familySessionView(existing.data as MicroRow);
  const pending = await getFamilyMicroSession();
  if (pending) return pending;
  const { graph, exposures } = await getFamilyContext(lexeme, db, userId);
  const decision = selectFamilyCandidate(graph, exposures, new Date());
  let lesson: FamilyLesson;
  try { lesson = buildFamilyLesson(graph, decision); }
  catch (error) { throw new FamilyServiceError(409, error instanceof Error ? error.message : "FAMILY_CONTENT_UNAVAILABLE", decision.reason); }
  const r = await db.rpc("start_family_micro_v1", { p_user_id: userId, p_request_id: requestId, p_lesson: lesson });
  fail(r.error);
  return familySessionView(r.data as MicroRow);
}
export async function submitFamilyStep(sessionId: string, index: number, answer: string) {
  const db = getDatabase(), userId = getAuthenticatedUserId();
  const read = await db.from("family_micro_sessions").select("*").eq("user_id", userId).eq("id", sessionId).maybeSingle();
  fail(read.error);
  if (!read.data) throw new FamilyServiceError(404, "FAMILY_SESSION_NOT_FOUND", "这个词族练习不存在。");
  const row = read.data as MicroRow;
  if (row.completed || index < row.index) return familySessionView(row);
  const step = row.lesson.steps[index];
  if (!step || index !== row.index) throw new FamilyServiceError(409, "FAMILY_STEP_STALE", "题目进度已变化，请恢复词族练习。");
  // Canonical initial-card scheduling, only at the last productive-recall step.
  let card: Record<string, unknown> | null = null, log: Record<string, unknown> | null = null;
  if (index === row.lesson.steps.length - 1 && row.lesson.target_id && ["B", "C"].includes(row.lesson.stage)) {
    const empty = { next_review_at: null, last_reviewed_at: null, fsrs_stability: 0, fsrs_difficulty: 0, fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0, fsrs_learning_steps: 0, fsrs_reps: 0, fsrs_lapses: 0, fsrs_state: 0 } as UserWordRow;
    const result = scheduleReview(empty, normalizeLemma(answer) === normalizeLemma(step.answer) ? "good" : "again", new Date());
    card = cardToDatabase(result.card); log = reviewLogToDatabase(result.log);
  }
  const r = await db.rpc("submit_family_step_v1", { p_user_id: userId, p_session_id: sessionId, p_index: index, p_answer: answer, p_card: card, p_log: log });
  fail(r.error);
  return familySessionView(r.data as MicroRow);
}
