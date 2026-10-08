import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase, getAuthenticatedUserId } from "../db.js";
import { getFamilyContext } from "./familyGraph.js";
import { FamilyServiceError } from "./familyErrors.js";
import { normalizeLemma } from "./familyPolicy.js";
import type { GraphEdge, GraphView, LexicalGraph, NetworkType, NetworkQuery } from "../../shared/lexicalContracts.js";

// Collapse repeated evidence, never collapse different sense pairs or directions.
export function mergeGraphEvidence(edges: GraphEdge[]): GraphEdge[] {
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.source_id === edge.target_id || !edge.source || !edge.source_version || !edge.license ||
      !Object.keys(edge.provenance).length || !Number.isFinite(edge.confidence) || edge.confidence<0 || edge.confidence>1) continue;
    const endpoints = [[edge.source_id,edge.source_sense_id],[edge.target_id,edge.target_sense_id]];
    if(edge.direction==="undirected") endpoints.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const key = JSON.stringify([endpoints, edge.relation_type, edge.direction]);
    const prior = merged.get(key);
    if (!prior) merged.set(key, { ...edge, provenance: { ...edge.provenance } });
    else prior.provenance = { ...prior.provenance, additional_sources: [
      ...(prior.provenance.additional_sources as unknown[] ?? []), { source: edge.source, source_version: edge.source_version,
        license: edge.license, provenance: edge.provenance, confidence: edge.confidence, relation_id:edge.relation_id,
        source_id:edge.source_id,target_id:edge.target_id,source_sense_id:edge.source_sense_id,target_sense_id:edge.target_sense_id,
        direction:edge.direction,explanation:edge.explanation },
    ] };
  }
  return [...merged.values()];
}
export async function getLexicalGraph(lexeme: string, view: GraphView, types?: NetworkType[],
  db: SupabaseClient = getDatabase(), userId = getAuthenticatedUserId(), options?: NetworkQuery): Promise<LexicalGraph> {
  if (view === "family") {
    const { graph } = await getFamilyContext(lexeme, db, userId);
    const nodes = graph.nodes.map(n => ({ ...n, node_id: n.lexeme_id, node_type: "lexeme" as const, learner_state: n.user_state }));
    return { ...graph, view, center: nodes.find(n => n.node_id === graph.center.lexeme_id)!, nodes,
      edges: graph.edges.map(e => ({ ...e, relation_type: "MORPHOLOGICAL_DERIVATION", explanation: e.morphology ?? "" })) };
  }
  const defaults = types ?? ["SYNONYM", "ANTONYM", "CONTRAST", "COLLOCATION"];
  const result = options?.version===2 && view==="network"
    ? await db.rpc("get_lexical_graph_v2", {p_user_id:userId,p_entity:normalizeLemma(lexeme),p_types:defaults,
      p_pos:options.pos??null,p_sense_id:options.sense_id??null,p_scope:options.scope??"sense",p_offset:options.offset??0,p_limit:options.limit??8,
      p_include_folded:options.include_folded??false,p_evidence_offset:options.evidence_offset??0})
    : await db.rpc("get_lexical_graph_v1", { p_user_id: userId, p_entity: normalizeLemma(lexeme), p_view: view,
      p_types: defaults, p_limit: 24 });
  if(result.error?.message?.includes("LEXICAL_REQUEST_INVALID") || result.error?.message?.includes("LEXICAL_SENSE_INVALID"))
    throw new FamilyServiceError(400,"LEXICAL_REQUEST_INVALID","词性或义项不属于当前词条。");
  if (result.error) throw new FamilyServiceError(503, "LEXICAL_QUERY_FAILED", "图谱暂时不可用，请确认已安装图谱迁移。");
  if (!result.data) throw new FamilyServiceError(404, "LEXICAL_NOT_FOUND", "暂无这个词的已核验词典数据。");
  const graph = result.data as LexicalGraph;
  graph.edges = mergeGraphEvidence(graph.edges);
  return graph;
}
