import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { assertDatabaseResult } from "./shared.js";
import { BKT_PARAMS, BKT_VERSION, predictCorrect, predictionMetrics, updateBkt } from "./bkt.js";
import type { EvidenceQuality } from "../../shared/learningEvidence.js";

/** Bounded, replayable shadow projection. The event is already durable before this runs. */
export async function consumeSkillEvidence(db = getDatabase(), userId = getAuthenticatedUserId()): Promise<void> {
  const mode = await db.from("learning_settings").select("bkt_mode").eq("user_id", userId).maybeSingle();
  assertDatabaseResult(mode.error);
  if (mode.data?.bkt_mode === "off") return;
  const pending = await db.rpc("pending_skill_evidence_v1", { p_user_id: userId });
  assertDatabaseResult(pending.error);
  for (const e of (pending.data ?? []) as Array<{ id: number; skill_id: string; quality: EvidenceQuality; outcome: string }>) {
    for (let retry = 0; retry < 3; retry++) {
      const state = await db.from("user_skill_state").select("p_mastery,revision").eq("user_id", userId).eq("skill_id", e.skill_id).eq("bkt_version", BKT_VERSION).maybeSingle();
      assertDatabaseResult(state.error);
      const before = state.data?.p_mastery ?? BKT_PARAMS.prior;
      const correct = e.outcome === "correct" ? true : e.outcome === "incorrect" ? false : null;
      const quality = correct === null ? "IGNORE" : e.quality;
      const saved = await db.rpc("commit_bkt_update_v1", { p_user_id: userId, p_evidence_id: e.id,
        p_expected_revision: state.data?.revision ?? 0, p_next: updateBkt(before, quality, correct),
        p_prediction: predictCorrect(before), p_quality: quality, p_correct: correct });
      assertDatabaseResult(saved.error);
      if (saved.data === true) break;
      if (retry === 2) throw new Error("BKT_RETRY_PENDING");
    }
  }
}

export async function tryConsumeSkillEvidence(db = getDatabase(), userId = getAuthenticatedUserId()) {
  try { await consumeSkillEvidence(db, userId); }
  catch { console.warn("BKT shadow projection pending replay"); }
}

export async function getEvidenceEvaluation(db = getDatabase(), userId = getAuthenticatedUserId()) {
  await tryConsumeSkillEvidence(db, userId);
  const [evidence, gold, updates, states] = await Promise.all([
    db.from("exercise_skill_evidence").select("id,submission_id,skill_id,outcome,quality,quality_reason,evidence_version,created_at").eq("user_id", userId).eq("evidence_version", "evidence-v1").order("id", { ascending: false }).limit(200),
    db.from("evidence_gold_labels").select("evidence_id,outcome,error_label,reviewed_at").eq("user_id", userId).order("reviewed_at", { ascending: false }).limit(1000),
    db.from("bkt_updates").select("skill_id,prediction,correct,quality,created_at").eq("user_id", userId).eq("quality", "OBSERVE").eq("bkt_version", BKT_VERSION).order("created_at", { ascending: false }).limit(1000),
    db.from("user_skill_state").select("skill_id,p_mastery,evidence_count,learning_count,updated_at").eq("user_id", userId).eq("bkt_version", BKT_VERSION),
  ]);
  for (const r of [evidence, gold, updates, states]) assertDatabaseResult(r.error);
  const labels = new Map((gold.data ?? []).map(g => [g.evidence_id, g]));
  const ids = [...new Set((evidence.data ?? []).map(e => e.submission_id))];
  const attempts = ids.length ? await db.from("attempts").select("submission_id,user_answer,error_layer").eq("user_id",userId).in("submission_id",ids) : { data: [], error: null };
  const events = ids.length ? await db.from("exercise_submission_events").select("submission_id,result").eq("user_id",userId).in("submission_id",ids) : { data: [], error: null };
  assertDatabaseResult(attempts.error); assertDatabaseResult(events.error);
  const rows = (evidence.data ?? []).map(e => {
    const attempt = attempts.data?.find(a => a.submission_id === e.submission_id);
    const saved = events.data?.find(a => a.submission_id === e.submission_id)?.result as Record<string, any> | undefined;
    const payload = saved?.state?.payload ?? {};
    const { submission_id: _submission, ...sample } = e;
    return { ...sample, prompt: redactSample(payload.exercise?.prompt ?? payload.prompt ?? "原题缺失：请勿标注"),
      answer: redactSample(attempt?.user_answer ?? ""), error_label: attempt?.error_layer ?? "none", gold: labels.get(e.id) ?? null };
  });
  const metrics = new Map<string, { skill_id: string; label: string; tp: number; fp: number; fn: number }>();
  for (const row of rows) {
    if (!row.gold) continue;
    for (const label of ["correct", "incorrect", "partial", "not_assessed"]) {
      const key = row.skill_id + ":" + label;
      const m = metrics.get(key) ?? { skill_id: row.skill_id, label, tp: 0, fp: 0, fn: 0 };
      if (row.outcome === label && row.gold.outcome === label) m.tp++;
      if (row.outcome === label && row.gold.outcome !== label) m.fp++;
      if (row.outcome !== label && row.gold.outcome === label) m.fn++;
      metrics.set(key, m);
    }
  }
  const errorLabels = ["none", "meaning", "collocation", "grammar", "spelling", "pronunciation"].map(label => {
    const reviewed = rows.filter(r => r.gold);
    const tp = reviewed.filter(r => r.error_label === label && r.gold!.error_label === label).length;
    const fp = reviewed.filter(r => r.error_label === label && r.gold!.error_label !== label).length;
    const fn = reviewed.filter(r => r.error_label !== label && r.gold!.error_label === label).length;
    return { label, tp, fp, fn, precision: tp+fp ? tp/(tp+fp) : null, recall: tp+fn ? tp/(tp+fn) : null };
  });
  const predictions = (updates.data ?? []).map(u => ({ prediction: u.prediction as number, correct: u.correct as boolean }));
  const history = new Map<string, { correct: number; count: number; streak: number }>();
  const empirical: Array<{ prediction: number; correct: boolean }> = [];
  const streak: Array<{ prediction: number; correct: boolean }> = [];
  for (const u of [...(updates.data ?? [])].reverse()) {
    const h = history.get(u.skill_id) ?? { correct: 0, count: 0, streak: 0 };
    empirical.push({ prediction: (h.correct + 1) / (h.count + 2), correct: u.correct });
    streak.push({ prediction: (h.streak + 1) / (h.streak + 2), correct: u.correct });
    h.correct += Number(u.correct); h.count++; h.streak = u.correct ? h.streak + 1 : 0; history.set(u.skill_id,h);
  }
  return { mode: "shadow", version: BKT_VERSION, params: BKT_PARAMS, calibrated: false,
    error_labels: errorLabels, evaluation_window: { samples: 200, observations: 1000, baselines: "prequential within this window; no future outcomes" },
    rows, states: states.data ?? [], reviewed_count: rows.filter(r => r.gold).length,
    observation_coverage: rows.length ? rows.filter(r => r.quality === "OBSERVE").length / rows.length : null,
    rejected_count: rows.filter(r => r.quality === "IGNORE").length,
    labels: [...metrics.values()].map(m => ({ ...m, precision: m.tp + m.fp ? m.tp / (m.tp + m.fp) : null, recall: m.tp + m.fn ? m.tp / (m.tp + m.fn) : null })),
    bkt: predictionMetrics(predictions), frequency_baseline: predictionMetrics(empirical), streak_baseline: predictionMetrics(streak), baseline: predictionMetrics(predictions.map(r => ({ ...r, prediction: predictCorrect(BKT_PARAMS.prior) }))) };
}

export async function labelEvidence(id: number, outcome: string, errorLabel: string, db = getDatabase(), userId = getAuthenticatedUserId()) {
  const owned = await db.from("exercise_skill_evidence").select("id").eq("user_id", userId).eq("id", id).eq("evidence_version", "evidence-v1").maybeSingle();
  assertDatabaseResult(owned.error);
  if (!owned.data) throw new Error("EVIDENCE_NOT_FOUND");
  const r = await db.from("evidence_gold_labels").upsert({ user_id: userId, evidence_id: id, outcome, error_label: errorLabel, reviewed_at: new Date().toISOString() });
  assertDatabaseResult(r.error);
  return { saved: true };
}

function redactSample(value: string): string {
  return value.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,"[email]")
    .replace(/https?:\/\/\S+/g,"[url]").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,"[id]")
    .replace(/\b1[3-9]\d{9}\b/g,"[phone]");
}
