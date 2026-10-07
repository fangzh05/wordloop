import { describe, it, expect } from "vitest";
import seed from "../server/data/familySeed.json" with { type: "json" };
import { lexemeId, localFamilyGraph, normalizeLemma, normalizeRelation, normalizeRelationType, selectFamilyCandidate } from "../server/services/familyPolicy.js";
import { buildFamilyLesson } from "../server/services/familyLesson.js";
import { familySessionView } from "../server/services/familyGraph.js";
import { mergeFamilyGraph } from "../web/src/family/FamilyPanel.js";
import { familyGraphQuerySchema, type FamilyNode, type LearnerState, type LexicalRelation } from "../shared/familyContracts.js";

const stable: LearnerState = { status: "review", stability: 8, reps: 3, consecutive_correct: 3, next_review_at: "2026-10-15T00:00:00Z", error_layers: [],
  layers: Object.fromEntries(["meaning", "spelling", "pronunciation", "collocation", "grammar"].map((key) => [key, { needs_practice: false, correct_streak: null }])) as LearnerState["layers"] };
function node(id: string, learned = false): FamilyNode {
  const l = seed.lexemes.find((l) => l.lexeme_id === id)!;
  return { ...l, user_state: learned ? structuredClone(stable) : null, senses: seed.senses.filter((s) => s.lexeme_id === id), forms: seed.forms.filter((f) => f.lexeme_id === id), priority: l.utility_score, reason: "verified morphology" };
}
const relations = seed.relations as LexicalRelation[];
function graph(id = "en:persuade:v", learned = true) { return localFamilyGraph(node(id, learned), seed.lexemes.map((l) => node(l.lexeme_id, l.lexeme_id === id && learned)), relations); }
const now = new Date("2026-10-07T12:00:00Z");
describe("Local Family lexical boundaries", () => {
  it("normalizes case, NFC and surrounding whitespace, without merging POS or distinct words", () => {
    expect(lexemeId("  PERSUADE  ", "v")).toBe("en:persuade:v");
    expect(normalizeLemma("  a   word ")).toBe("a word");
    expect(lexemeId("act", "n")).not.toBe(lexemeId("act", "v"));
    expect(() => lexemeId("persuade sb to do sth", "v")).toThrow();
  });
  it("does not automatically map pertainym, similarity, synonym or contrast into derivation", () => {
    expect(() => normalizeRelationType("pertainym")).toThrow();
    expect(normalizeRelationType("pertainym", true)).toBe("DERIVATION");
    expect(normalizeRelationType("synonym")).toBe("SYNONYM");
    expect(() => normalizeRelationType("embedding_similarity")).toThrow();
  });
  it("requires provenance, version, license and finite confidence", () => {
    for (const r of relations) expect(normalizeRelation(r)).toEqual(r);
    expect(() => normalizeRelation({ ...relations[0]!, license: "" })).toThrow();
    expect(() => normalizeRelation({ ...relations[0]!, confidence: NaN })).toThrow();
  });
  it("filters DERIVATION and confidence before the one-hop graph", () => {
    const g = graph();
    expect(g.nodes.map((n) => n.lemma)).toEqual(["persuade", "persuasion", "persuasive"]);
    expect(g.nodes.some((n) => ["convince", "dissuade", "persuasively"].includes(n.lemma))).toBe(false);
    const low = relations.map((r) => r.target_id === "en:persuasion:n" ? { ...r, confidence: .5 } : r);
    expect(localFamilyGraph(g.center, g.nodes, low).nodes.map((n) => n.lemma)).not.toContain("persuasion");
  });
  it("expands only on the selected next node and retains the original center", () => {
    const initial = graph(), next = graph("en:persuasive:a", false);
    const expanded = mergeFamilyGraph(initial, next);
    expect(initial.nodes.some((n) => n.lemma === "persuasively")).toBe(false);
    expect(expanded.nodes.some((n) => n.lemma === "persuasively")).toBe(true);
    expect(expanded.center.lexeme_id).toBe("en:persuade:v");
    expect(familyGraphQuerySchema.safeParse({ lexeme: "act", depth: 2 }).success).toBe(false);
  });
  it("deduplicates duplicate sources, nodes and handles cycles without recursion", () => {
    const g = graph();
    const duplicate = { ...relations[0]!, relation_id: "duplicate", source: "other" };
    const cycle = { ...relations[0]!, relation_id: "cycle", source_id: relations[0]!.target_id, target_id: relations[0]!.source_id };
    const next = localFamilyGraph(g.center, [...g.nodes, ...g.nodes], [...relations, duplicate, cycle]);
    expect(next.nodes).toHaveLength(g.nodes.length);
    expect(next.edges).toHaveLength(g.edges.length);
    expect(next.edges[0]!.provenance.additional_sources).toBeDefined();
  });
  it("caps large families and cumulative expansion", () => {
    const g = graph("en:act:v");
    const many = Array.from({ length: 100 }, (_, i) => ({ ...node("en:action:n"), lexeme_id: `fake-${i}` }));
    const edges = many.map((n, i) => ({ ...relations[0]!, relation_id: `edge-${i}`, source_id: g.center.lexeme_id, target_id: n.lexeme_id }));
    const local = localFamilyGraph(g.center, many, edges);
    expect(local.nodes).toHaveLength(24); expect(local.truncated).toBe(true);
    const merged = mergeFamilyGraph(local, { ...local, nodes: many, edges });
    expect(merged.nodes.length).toBeLessThanOrEqual(40);
  });
});
describe("Family progression and Deep Loop", () => {
  it("selects deterministically regardless of source and node order", () => {
    const g = graph(), choice = selectFamilyCandidate(g, [], now);
    expect(choice.candidate?.lemma).toBe("persuasion"); expect(choice.eligible_now).toBe(true);
    expect(selectFamilyCandidate({ ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }, [], now)).toEqual(choice);
  });
  it("keeps unstable bases at Stage A without activating a derivative", () => {
    const g = graph("en:reconcile:v", false), choice = selectFamilyCandidate(g, [], now);
    expect(choice.stage).toBe("A");
    const lesson = buildFamilyLesson(g, choice);
    expect(lesson.target_id).toBeNull(); expect(lesson.steps.every((s) => s.target_id === g.center.lexeme_id)).toBe(true);
  });
  it("penalizes interference and gates recent introductions across sibling centers", () => {
    const g = graph("en:economic:a");
    const exposure = { base_id: "en:economy:n", target_id: "en:economical:a", introduced_at: "2026-10-06T00:00:00Z" };
    const choice = selectFamilyCandidate(g, [exposure], now);
    expect(choice.eligible_now).toBe(false); expect(choice.reason).toContain("间隔");
    expect(selectFamilyCandidate(graph(), [{ base_id: "en:persuade:v", target_id: "en:persuasion:n", introduced_at: "2026-10-01T00:00:00Z" }], now).eligible_now).toBe(true);
  });
  it("blocks new siblings while an already introduced member is developing", () => {
    const g = graph(); g.nodes.find((n) => n.lemma === "persuasion")!.user_state = { ...stable, reps: 1 };
    expect(selectFamilyCandidate(g, [], now).eligible_now).toBe(false);
  });
  it("preserves family spacing beyond the visible one-hop graph", () => {
    const g = graph("en:act:v");
    const distant = { base_id: "en:activate:v", target_id: "en:activation:n", family_key: "act", introduced_at: "2026-10-06T00:00:00Z" };
    expect(selectFamilyCandidate(g, [distant], now).eligible_now).toBe(false);
    expect(selectFamilyCandidate({ ...g, has_developing_member: true }, [], now).eligible_now).toBe(false);
    expect(selectFamilyCandidate(g, [], now).eligible_now).toBe(true);
  });
  it("introduces only one item with context, POS change, base usage and productive recall", () => {
    const g = graph("en:reconcile:v"), c = selectFamilyCandidate(g, [], now), lesson = buildFamilyLesson(g, c);
    expect(lesson.target_id).toBe("en:reconciliation:n");
    expect(new Set(lesson.steps.map((s) => s.target_id)).size).toBe(2);
    expect(lesson.steps.filter((s) => s.activity_type === "collocation").map((s) => s.answer)).toEqual(["with", "to"]);
    expect(lesson.steps.at(-1)?.activity_type).toBe("word_recall");
  });
  it("uses Stage D only for learned stable forms and never activates another item", () => {
    const g = graph(); g.nodes.forEach((n) => { n.user_state = structuredClone(stable); });
    const c = selectFamilyCandidate(g, [], now); expect(c.stage).toBe("D");
    const lesson = buildFamilyLesson(g, c); expect(lesson.target_id).toBeNull(); expect(lesson.steps).toHaveLength(3);
  });
  it("does not send future exercise answers or explanations to the client", () => {
    const g = graph(), lesson = buildFamilyLesson(g, selectFamilyCandidate(g, [], now));
    const view = familySessionView({ id: "session", lesson, index: 1, completed: false, activated: false, feedback: undefined });
    expect(view.step).not.toHaveProperty("answer"); expect(view.step).not.toHaveProperty("explanation");
    expect(view).not.toHaveProperty("steps");
  });
});
