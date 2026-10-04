import type { SkillSignal } from "../../shared/toolContracts.js";
import { BKT_VERSION } from "./bkt.js";
import type { SupabaseClient } from "@supabase/supabase-js";

export type BktMode = "off" | "shadow" | "active";
export function bktMode(value: unknown): BktMode {
  return value === "active" || value === "off" ? value : "shadow";
}

/** Only independent observations qualify; assisted exposure cannot enable selection. */
export async function loadBktPlannerSignals(db: SupabaseClient, userId: string) {
  const settings = await db.from("learning_settings").select("bkt_mode").eq("user_id", userId).maybeSingle();
  if (settings.error) throw settings.error;
  const mode = bktMode(settings.data?.bkt_mode);
  if (mode === "off") return { mode, signals: [] as SkillSignal[] };
  const states = await db.from("user_skill_state").select("skill_id,p_mastery,evidence_count")
    .eq("user_id", userId).eq("bkt_version", BKT_VERSION);
  if (states.error) throw states.error;
  const signals: SkillSignal[] = (states.data ?? [])
    .filter(s => Number.isInteger(s.evidence_count) && s.evidence_count >= 5
      && Number.isFinite(s.p_mastery) && s.p_mastery >= 0 && s.p_mastery <= 1)
    .map(s => ({ skill_id: s.skill_id,
      state: s.p_mastery < .6 ? "needs_practice" : s.p_mastery >= .9 ? "ready" : "developing",
      source: "adapter", confidence: 1 - s.p_mastery, reason: `bkt_${mode}:${BKT_VERSION}` }));
  return { mode, signals };
}
