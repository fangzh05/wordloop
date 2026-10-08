import { z } from "zod";
import type { FamilyNode, SourceMetadata } from "./familyContracts.js";
import type { Sense } from "./familyContracts.js";

export const NETWORK_VISIBLE_LIMIT = 8;
export const NETWORK_PAGE_LIMIT = 8;
export interface NetworkQuery {
  version?: 2; pos?: string; sense_id?: string; scope?: "sense" | "unscoped"; offset?: number; limit?: number; include_folded?: boolean; evidence_offset?: number;
}
export interface NetworkGroup {
  group_id: string; node_ids: string[]; edge_ids: string[];
  variants: Array<{ lexeme_id: string; label: string; source: string; provenance: Record<string, unknown> }>;
}
export interface NetworkSelection {
  selected_sense_id: string | null; scope: "sense" | "unscoped";
  lexeme_options: Array<{ lexeme_id: string; lemma: string; part_of_speech: string; senses: Sense[] }>;
  groups: NetworkGroup[]; total_groups: number; next_offset: number | null; unscoped_count: number;
  ordering: string; folded_count: number; next_evidence_offset: number | null;
}

export const NETWORK_TYPES = ["SYNONYM", "ANTONYM", "CONTRAST", "CONFUSABLE", "COLLOCATION", "HYPERNYM", "HYPONYM"] as const;
export type NetworkType = typeof NETWORK_TYPES[number];
export type GraphView = "family" | "root" | "network";
export type GraphRelationType = NetworkType | "MORPHOLOGICAL_DERIVATION" | "ETYMOLOGICAL_ORIGIN" | "SHARED_ETYMON" | "PREFIX" | "ROOT" | "SUFFIX";
export interface LexicalWordNode extends FamilyNode { node_id: string; node_type: "lexeme"; learner_state: FamilyNode["user_state"] }
export interface KnowledgeNode extends SourceMetadata {
  node_id: string; node_type: "etymon" | "pattern" | "morpheme"; lemma: string;
  language: string; gloss: string; explanation: string; period?: string | null;
  example?: string | null; sense_id?: string | null; uncertain?: boolean;
}
export type LexicalNode = LexicalWordNode | KnowledgeNode;
export interface GraphEdge extends SourceMetadata {
  relation_id: string; source_id: string; target_id: string; relation_type: GraphRelationType;
  direction: "forward" | "undirected"; explanation: string;
  source_sense_id?: string | null; target_sense_id?: string | null;
  source_definition?: string | null; target_definition?: string | null;
  source_examples?: string[] | null; target_examples?: string[] | null;
}
export interface LexicalGraph {
  view: GraphView; center: LexicalNode; nodes: LexicalNode[]; edges: GraphEdge[]; depth: 1; truncated: boolean;
  network?: NetworkSelection;
}
export const lexicalGraphQuerySchema = z.object({
  lexeme: z.string().trim().min(1).max(160), view: z.enum(["family", "root", "network"]),
  depth: z.coerce.number().int().min(1).max(1).default(1),
  relation_types: z.string().max(120).optional(),
  version: z.coerce.number().int().min(2).max(2).optional(),
  pos: z.enum(["n", "v", "a", "r"]).optional(),
  sense_id: z.string().trim().min(1).max(200).optional(),
  scope: z.enum(["sense", "unscoped"]).optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(NETWORK_PAGE_LIMIT).optional(),
  include_folded: z.enum(["true","false"]).transform(v=>v==="true").optional(),
  evidence_offset: z.coerce.number().int().min(0).max(10000).optional(),
}).strict().superRefine((q, ctx) => {
  if ([q.version,q.pos,q.sense_id,q.scope,q.offset,q.limit,q.include_folded,q.evidence_offset].some(v=>v!==undefined) && (q.view!=="network" || q.version!==2))
    ctx.addIssue({code:"custom",message:"Sense selection requires network V2"});
  if(q.scope==="unscoped" && q.sense_id!==undefined) ctx.addIssue({code:"custom",message:"Unscoped evidence has no selected sense"});
  if (q.relation_types !== undefined && (q.view !== "network" ||
    (q.relation_types !== "" && q.relation_types.split(",").some(t => !(NETWORK_TYPES as readonly string[]).includes(t)))))
    ctx.addIssue({ code: "custom", message: "Invalid network filter", path: ["relation_types"] });
});
export const RELATION_LABELS: Record<GraphRelationType, string> = {
  SYNONYM: "近义（指定词义）", ANTONYM: "反义", CONTRAST: "对比", CONFUSABLE: "易混",
  COLLOCATION: "搭配", HYPERNYM: "上位", HYPONYM: "下位",
  MORPHOLOGICAL_DERIVATION: "现代派生", ETYMOLOGICAL_ORIGIN: "历史来源", SHARED_ETYMON: "共同祖源",
  PREFIX: "前缀", ROOT: "词根成分", SUFFIX: "后缀",
};
