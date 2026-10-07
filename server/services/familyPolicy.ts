import type { FamilyCandidate, FamilyGraph, FamilyNode, LexicalRelation } from "../../shared/familyContracts.js";
import { FAMILY_MIN_CONFIDENCE, FAMILY_NODE_LIMIT, RELATION_TYPES } from "../../shared/familyContracts.js";

export function normalizeLemma(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}
export function lexemeId(lemma: string, pos: string, language = "en"): string {
  const normalized = normalizeLemma(lemma);
  if (!/^[a-z]+(?:[-'][a-z]+)*$/u.test(normalized)) throw new Error("FAMILY_LEXEME_INVALID");
  if (!["n", "v", "a", "r"].includes(pos) || language !== "en") throw new Error("FAMILY_LEXEME_INVALID");
  return `${language}:${normalized}:${pos}`;
}
/** Source types are explicit. Pertainym requires individually reviewed morphology. */
export function normalizeRelationType(raw: string, morphologyVerified = false): LexicalRelation["relation_type"] {
  const type = raw.trim().toUpperCase();
  if (type === "PERTAINYM" && morphologyVerified) return "DERIVATION";
  if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new Error("FAMILY_RELATION_UNVERIFIED");
  return type as LexicalRelation["relation_type"];
}
export function normalizeRelation(relation: LexicalRelation): LexicalRelation {
  if (!relation.source.trim() || !relation.source_version.trim() || !relation.license.trim()
    || !Object.keys(relation.provenance).length || !Number.isFinite(relation.confidence)
    || relation.confidence < 0 || relation.confidence > 1 || relation.source_id === relation.target_id) {
    throw new Error("FAMILY_RELATION_INVALID");
  }
  return { ...relation, relation_type: normalizeRelationType(relation.relation_type) };
}
export function localFamilyGraph(center: FamilyNode, nodes: readonly FamilyNode[], relations: readonly LexicalRelation[]): FamilyGraph {
  const valid = relations.filter((r) => r.relation_type === "DERIVATION" && r.confidence >= FAMILY_MIN_CONFIDENCE
    && (r.source_id === center.lexeme_id || r.target_id === center.lexeme_id) && r.source_id !== r.target_id);
  const byId = new Map(nodes.map((n) => [n.lexeme_id, n]));
  byId.set(center.lexeme_id, center);
  const adjacent = new Set(valid.flatMap((r) => [r.source_id, r.target_id]));
  adjacent.delete(center.lexeme_id);
  const neighbours = [...adjacent].map((id) => byId.get(id)).filter((n): n is FamilyNode => Boolean(n))
    .sort((a, b) => b.priority - a.priority || a.lexeme_id.localeCompare(b.lexeme_id)).slice(0, FAMILY_NODE_LIMIT - 1);
  const visible = new Set([center.lexeme_id, ...neighbours.map((n) => n.lexeme_id)]);
  // Collapse repeated source evidence into one visual edge, retaining evidence arrays.
  const edges = new Map<string, LexicalRelation>();
  for (const r of [...valid].sort((a, b) => b.confidence - a.confidence || a.relation_id.localeCompare(b.relation_id))) {
    if (!visible.has(r.source_id) || !visible.has(r.target_id)) continue;
    const key = [r.source_id, r.target_id].sort().join("|");
    const prior = edges.get(key);
    if (prior) prior.provenance = { ...prior.provenance, additional_sources: [...(prior.provenance.additional_sources as unknown[] ?? []), { source: r.source, source_version: r.source_version, license: r.license, provenance: r.provenance, confidence: r.confidence }] };
    else edges.set(key, { ...r, provenance: { ...r.provenance } });
  }
  return { center, nodes: [center, ...neighbours], edges: [...edges.values()], depth: 1, truncated: adjacent.size > neighbours.length };
}
export function baseStable(node: FamilyNode): boolean {
  const state = node.user_state;
  return Boolean(state && state.reps >= 2 && state.stability >= 3 && state.consecutive_correct >= 2
    && !state.error_layers.some((e) => e === "meaning" || e === "spelling") && state.status !== "new");
}
export interface FamilyExposure { base_id: string; target_id: string | null; introduced_at: string; family_key?: string }
/** Pure rules: no random, ML, LLM, clock or source-order dependence. */
export function selectFamilyCandidate(graph: FamilyGraph, exposures: readonly FamilyExposure[], now: Date): FamilyCandidate {
  const eligible = graph.nodes.filter((n) => n.lexeme_id !== graph.center.lexeme_id);
  if (!baseStable(graph.center)) return { candidate: null, relation: null, reason: graph.center.user_state ? "先把当前词的意义和拼写学稳，再引入派生词。" : "这个词尚未学习，可先加入未来候选；从正在学习的词开始短练习。", eligible_now: false, stage: "A", utility: null };
  const connected = new Set(graph.nodes.map((n) => n.lexeme_id));
  const relevant = exposures.filter((e) => e.family_key === graph.center.family_key || connected.has(e.base_id) || (e.target_id && connected.has(e.target_id)));
  const learned = eligible.filter(baseStable);
  const stage = learned.length >= 2 ? "D" : relevant.length ? "C" : "B";
  const last = relevant.map((e) => Date.parse(e.introduced_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const cooling = last !== undefined && now.getTime() - last < 3 * 86400000;
  const developing = graph.has_developing_member || eligible.some((n) => n.user_state && !baseStable(n));
  const scored = eligible.filter((node) => stage === "D" ? baseStable(node)
    : graph.edges.some((r) => r.source_id === graph.center.lexeme_id && r.target_id === node.lexeme_id)).map((node) => {
    const relation = graph.edges.find((e) => e.source_id === node.lexeme_id || e.target_id === node.lexeme_id)!;
    const frequency = node.frequency_band === null ? 0.5 : Math.max(0.1, 1 - (node.frequency_band - 1) / 6);
    const userNeed = !node.user_state ? 1 : baseStable(node) ? 0.15 : 0.65;
    const score = node.utility_score * (0.5 + 0.5 * node.exam_relevance) * relation.transparency
      * frequency * userNeed * (1 - 0.8 * relation.interference_risk);
    return { node, relation, score };
  }).sort((a, b) => b.score - a.score || a.node.lexeme_id.localeCompare(b.node.lexeme_id));
  const best = scored.find((s) => !s.node.user_state) ?? scored[0];
  if (!best) return { candidate: null, relation: null, stage, eligible_now: false, utility: null, reason: "当前没有已核验的高价值派生词。" };
  if (stage === "D") return { candidate: best.node, relation: best.relation, stage, eligible_now: !cooling, utility: best.node.utility_score, reason: cooling ? "刚练过这个词族，间隔后再做词性和语境辨析。" : "已有多个稳定成员，可以练习词性和语境辨析。" };
  const highValue = best.node.utility_score >= 0.6 && best.relation.transparency >= 0.6;
  const reason = cooling || developing ? "暂不引入下一个派生词：近期词族成员仍在学习，先留出间隔，避免互相干扰。"
    : !highValue ? "这个派生词当前价值有限，先留作未来候选。"
      : `${best.node.lemma} 是 ${graph.center.lemma} 的高价值派生${best.node.part_of_speech === "n" ? "名词" : best.node.part_of_speech === "a" ? "形容词" : "词"}，本次只学习这一个。`;
  return { candidate: best.node, relation: best.relation, stage, reason, eligible_now: highValue && !cooling && !developing && !best.node.user_state, utility: best.node.utility_score };
}
