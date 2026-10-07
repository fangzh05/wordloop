import type { FamilyCandidate, FamilyGraph, FamilyLesson, FamilyNode, FamilyStep } from "../../shared/familyContracts.js";
import { baseStable } from "./familyPolicy.js";

// Original WordLoop teaching material. Relations are loaded separately from
// sourced lexical data: a lesson cannot introduce a new lexical assertion.
export const FAMILY_TEACHING: Record<string, { meaning: string; context: string; usage?: Array<[string, string, string]> }> = {
  persuade: { meaning: "说服某人做某事", context: "They tried to ___ him to stay.", usage: [["persuade someone ___ do something", "to", "persuade sb to do sth：说服某人做某事。"], ["persuade someone ___ doing something", "into", "persuade sb into doing sth：说服某人做某事。"]] },
  persuasion: { meaning: "说服；劝说", context: "It took a lot of ___ to change her mind." },
  persuasive: { meaning: "有说服力的", context: "She gave a ___ argument." },
  persuasively: { meaning: "有说服力地", context: "She argued ___ for the proposal." },
  reconcile: { meaning: "调和；使和解；使接受现实", context: "We must ___ these opposing views.", usage: [["reconcile A ___ B", "with", "reconcile A with B：调和两者。"], ["reconcile yourself ___ something", "to", "reconcile yourself to sth：使自己接受某种现实。"]] },
  reconciliation: { meaning: "和解；调和", context: "Both sides are working toward ___." },
  reconcilable: { meaning: "可以调和的", context: "The two accounts are ___ if we check the dates." },
  economy: { meaning: "经济；经济体系", context: "The country's ___ is growing." },
  economic: { meaning: "经济方面的", context: "The report discusses ___ growth." },
  economical: { meaning: "节约的；经济实惠的", context: "This car is ___ to run." },
  economics: { meaning: "经济学", context: "She studies ___ at university." },
  act: { meaning: "行动；表演", context: "We need to ___ now." },
  action: { meaning: "行动；行为", context: "We need immediate ___." },
  active: { meaning: "活跃的；积极的", context: "She plays an ___ role in the club." },
  actively: { meaning: "积极地；主动地", context: "She ___ participates in class." },
  activity: { meaning: "活动", context: "Swimming is my favourite ___." },
  activate: { meaning: "激活；使启动", context: "Press the button to ___ the device." },
  activation: { meaning: "激活；启动", context: "Account ___ requires a code." },
  actor: { meaning: "演员", context: "The ___ performed on stage." },
};
function recall(node: FamilyNode): FamilyStep {
  const teaching = FAMILY_TEACHING[node.lemma];
  if (!teaching) throw new Error("FAMILY_CONTENT_UNAVAILABLE");
  return { target_id: node.lexeme_id, activity_type: "word_recall", error_layer: "spelling",
    prompt: `写出表示「${teaching.meaning}」的${node.part_of_speech === "n" ? "名词" : node.part_of_speech === "a" ? "形容词" : node.part_of_speech === "r" ? "副词" : "动词"}。`,
    answer: node.lemma, explanation: `${node.lemma}：${teaching.meaning}。` };
}
function context(node: FamilyNode): FamilyStep {
  const teaching = FAMILY_TEACHING[node.lemma];
  if (!teaching) throw new Error("FAMILY_CONTENT_UNAVAILABLE");
  return { target_id: node.lexeme_id, activity_type: "derivation", error_layer: "grammar",
    prompt: `填入正确形式：${teaching.context}`, answer: node.lemma, explanation: `此处需要 ${node.part_of_speech}：${teaching.meaning}。` };
}
export function buildFamilyLesson(graph: FamilyGraph, decision: FamilyCandidate): FamilyLesson & { target_meaning_zh?: string } {
  const base = graph.center;
  if (!FAMILY_TEACHING[base.lemma]) throw new Error("FAMILY_CONTENT_UNAVAILABLE");
  if (decision.stage !== "A" && !decision.eligible_now) throw new Error("FAMILY_SPACING_REQUIRED");
  const basePractice: FamilyStep[] = (FAMILY_TEACHING[base.lemma]!.usage ?? []).map(([prompt, answer, explanation]) => ({
    target_id: base.lexeme_id, activity_type: "collocation", error_layer: "collocation", prompt: `填入介词：${prompt}`, answer, explanation,
  }));
  if (decision.stage === "A") return { base_id: base.lexeme_id, target_id: null, stage: "A",
    explanation: "先稳定当前词。今天不激活派生词；词族仍可浏览。", steps: [recall(base), ...basePractice, context(base)].slice(0, 4) };
  if (decision.stage === "D") {
    const members = graph.nodes.filter((n) => baseStable(n) && FAMILY_TEACHING[n.lemma]).slice(0, 3);
    if (members.length < 3) throw new Error("FAMILY_CONTRAST_NOT_READY");
    return { base_id: base.lexeme_id, target_id: null, stage: "D", explanation: "用词性和语境主动选择正确形式。此轮只练习已有词，不引入新词。",
      steps: members.map(context) };
  }
  const target = decision.candidate;
  if (!target || !decision.relation || !FAMILY_TEACHING[target.lemma]) throw new Error("FAMILY_CONTENT_UNAVAILABLE");
  return { base_id: base.lexeme_id, target_id: target.lexeme_id, stage: decision.stage,
    target_meaning_zh: FAMILY_TEACHING[target.lemma]!.meaning,
    explanation: `${decision.relation.morphology ?? "比较词性变化。"} ${target.lemma}：${FAMILY_TEACHING[target.lemma]!.meaning}。`,
    steps: [
      { target_id: base.lexeme_id, activity_type: "derivation", error_layer: "grammar", prompt: `${target.lemma} 的词性是什么？输入 n / v / a / r。`, answer: target.part_of_speech, explanation: `词性由 ${base.part_of_speech} 变为 ${target.part_of_speech}。` },
      context(target), ...basePractice, ...(basePractice.length ? [] : [context(base)]), recall(target),
    ] };
}
