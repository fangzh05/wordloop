import { z } from "zod";
import type { FamilyNode, SourceMetadata } from "./familyContracts.js";

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
}
export interface LexicalGraph {
  view: GraphView; center: LexicalNode; nodes: LexicalNode[]; edges: GraphEdge[]; depth: 1; truncated: boolean;
}
export const lexicalGraphQuerySchema = z.object({
  lexeme: z.string().trim().min(1).max(160), view: z.enum(["family", "root", "network"]),
  depth: z.coerce.number().int().min(1).max(1).default(1),
  relation_types: z.string().max(120).optional(),
}).strict().superRefine((q, ctx) => {
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
