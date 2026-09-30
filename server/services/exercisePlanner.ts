import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { getVocabularyItemsByWords } from "./words.js";
import { normalizeWord } from "./wordNormalization.js";
import { deriveLessonProfile } from "./lessonProfile.js";
import {
  lessonExercisePlanSchema,
  plannedActivityTypeSchema,
  type ActiveErrorLayer,
  type LessonExercisePlan,
  type LessonProfile,
  type PlannedActivityType,
  type SkillSignal,
} from "../../shared/toolContracts.js";

export interface PlannerWord {
  word_id: string;
  word: string;
  target_sense: string;
  part_of_speech?: string | null;
  lesson_profile: LessonProfile;
  error_focus: ActiveErrorLayer | null;
  is_relearn?: boolean;
  has_useful_derivation?: boolean;
}

export interface RecentPlannedActivity {
  scope: "lesson" | "review" | "consolidation";
  activity_type: string;
  error_focus?: ActiveErrorLayer | null;
  content_sufficient?: boolean;
  exception_reason?: string | null;
}

export interface ExercisePlannerInput {
  words: readonly PlannerWord[];
  recent_activities?: readonly RecentPlannedActivity[];
  skill_signals?: readonly SkillSignal[];
  id_factory?: () => string;
}

const extractionActivities = new Set<PlannedActivityType>(["exact_cloze", "word_recall", "recall", "cloze", "spelling"]);
const rotationCandidates: PlannedActivityType[] = ["word_recall", "exact_cloze", "collocation", "derivation"];

function deterministicSkillSignals(word: PlannerWord): SkillSignal[] {
  const signal: SkillSignal = {
    skill_id: word.error_focus === "spelling" ? "target_word_spelling"
      : word.error_focus === "collocation" ? collocationSkill(word.part_of_speech)
        : word.error_focus === "grammar" ? "syntactic_word_use"
          : "target_sense_retrieval",
    state: word.error_focus ? "needs_practice" : word.lesson_profile === "reinforce" ? "developing" : "unknown",
    source: "rules",
    word_id: word.word_id,
    confidence: word.error_focus ? 1 : word.lesson_profile === "reinforce" ? 0.7 : 0.5,
    reason: word.error_focus ? `active_${word.error_focus}_error` : `lesson_profile_${word.lesson_profile}`,
  };
  return [signal];
}

function collocationSkill(partOfSpeech?: string | null): string {
  const pos = (partOfSpeech ?? "").toLocaleLowerCase();
  if (/\b(v|verb)\b/.test(pos)) return "verb_object_collocation";
  if (/\b(adj|adjective)\b/.test(pos)) return "adjective_complement_pattern";
  if (/\b(n|noun)\b/.test(pos)) return "noun_preposition_collocation";
  return "lexical_collocation";
}

function skillIdsFor(word: PlannerWord, activity: PlannedActivityType, signals: readonly SkillSignal[] = []): string[] {
  if (word.error_focus === "spelling") return ["target_word_spelling"];
  if (word.error_focus === "collocation" || activity === "collocation") return [collocationSkill(word.part_of_speech)];
  if (word.error_focus === "grammar") return ["syntactic_word_use"];
  if (activity === "derivation") return ["morphological_family"];
  if (activity === "translation_cn_to_en") {
    const relevantSignals = signals
      .filter((signal) => signal.state === "needs_practice")
      .map((signal) => signal.skill_id)
      .filter((skillId) => skillId === "target_sense_retrieval" || skillId === "syntactic_word_use"
        || skillId === collocationSkill(word.part_of_speech));
    // Translation is the prompt format. A short translation may provide
    // evidence about lexical recall, collocation, or syntax, each separately.
    return [...new Set(["target_sense_retrieval", collocationSkill(word.part_of_speech), ...relevantSignals])];
  }
  return ["target_sense_retrieval"];
}

function estimatedSeconds(activity: PlannedActivityType): number {
  if (activity === "translation_cn_to_en") return 38;
  if (activity === "collocation" || activity === "derivation") return 25;
  return 20;
}

function isOrdinary(word: PlannerWord): boolean {
  return !word.is_relearn && word.error_focus === null;
}

function appliesToCollocation(word: PlannerWord): boolean {
  return Boolean(word.target_sense.trim() && word.word.trim().length > 2);
}

function activityAllowed(word: PlannerWord, activity: PlannedActivityType): boolean {
  if (activity === "derivation") return word.has_useful_derivation === true;
  if (activity === "collocation") return appliesToCollocation(word);
  return true;
}

function defaultActivity(word: PlannerWord, roundIndex: number): PlannedActivityType {
  if (word.error_focus === "spelling") return "word_recall";
  if (word.error_focus === "collocation") return "collocation";
  if (word.error_focus === "grammar") return "translation_cn_to_en";
  if (word.error_focus === "meaning") return "word_recall";
  if (word.error_focus === "pronunciation") return "word_recall";
  if (word.lesson_profile === "reinforce" && roundIndex === 0) return "translation_cn_to_en";
  return "word_recall";
}

function recentTypes(history: readonly RecentPlannedActivity[]): PlannedActivityType[] {
  return history
    .filter((item) => item.scope !== "review")
    .map((item) => item.activity_type)
    .filter((item): item is PlannedActivityType =>
      item === "exact_cloze" || item === "word_recall" || item === "recall" || item === "cloze" || item === "spelling"
      || item === "translation_cn_to_en" || item === "collocation" || item === "derivation")
    .slice(0, 19);
}

function rollingCoverageNeed(history: readonly PlannedActivityType[]): PlannedActivityType | null {
  if (history.length < 19) return null;
  const translations = history.filter((activity) => activity === "translation_cn_to_en").length;
  const distinct = new Set(history).size;
  const retrieval = history.filter((activity) => extractionActivities.has(activity)).length;
  if (translations < 2) return "translation_cn_to_en";
  if (retrieval >= 15) return "collocation";
  if (distinct < 3) return rotationCandidates.find((activity) => !history.includes(activity)) ?? "collocation";
  return null;
}

function selectActivity(
  word: PlannerWord,
  index: number,
  roundSize: number,
  precedingTypes: readonly PlannedActivityType[],
  skillSignals: readonly SkillSignal[],
): { activity: PlannedActivityType; reason: string; exception?: string } {
  const special = word.error_focus !== null;
  const need = rollingCoverageNeed(precedingTypes);
  if (special) {
    const activity = defaultActivity(word, index);
    if (activityAllowed(word, activity)) {
      const exception = need && activity !== need
        ? `专项错误 ${word.error_focus} 优先于最近 20 道题的覆盖目标。`
        : undefined;
      return { activity, reason: `优先处理专项错误 ${word.error_focus}，使用适配的短题。`, ...(exception ? { exception } : {}) };
    }
  }

  const signal = skillSignals
    .filter((candidate) => candidate.state === "needs_practice"
      && (!candidate.word_id || candidate.word_id === word.word_id))
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))[0];
  const signalActivity: PlannedActivityType | null = signal?.skill_id === "target_word_spelling" ? "word_recall"
    : ["verb_object_collocation", "adjective_complement_pattern", "noun_preposition_collocation", "lexical_collocation"].includes(signal?.skill_id ?? "") ? "collocation"
      : signal?.skill_id === "morphological_family" && word.has_useful_derivation ? "derivation"
      : signal?.skill_id === "syntactic_word_use" ? "translation_cn_to_en"
          : signal?.skill_id === "target_sense_retrieval" ? "word_recall" : null;
  if (signalActivity && activityAllowed(word, signalActivity)) {
    const exception = need && signalActivity !== need
      ? `技能信号 ${signal?.skill_id} 的近期表现优先于短题覆盖目标。`
      : undefined;
    return {
      activity: signalActivity,
      reason: `依据 ${signal?.source} 提供的 ${signal?.skill_id} 技能信号安排适用任务。`,
      ...(exception ? { exception } : {}),
    };
  }

  if (need && activityAllowed(word, need)) {
    return { activity: need, reason: "补足最近 20 道短题的类型覆盖。" };
  }

  const alreadyHasTranslation = precedingTypes.slice(-Math.max(1, roundSize)).includes("translation_cn_to_en");
  if (!alreadyHasTranslation && (index === 0 || (roundSize >= 6 && index === 1))) {
    return { activity: "translation_cn_to_en", reason: "保证本轮包含一道短中译英。" };
  }

  // A compact collocation task adds a second task family in every ordinary
  // round. Derivation is used only when lexical metadata confirms it is useful.
  const roundTypes = precedingTypes.slice(-Math.max(0, roundSize - 1));
  if (isOrdinary(word) && !roundTypes.includes("collocation") && index === Math.min(1, roundSize - 1)
    && activityAllowed(word, "collocation")) {
    return { activity: "collocation", reason: "增加有语境线索的搭配提取，避免整轮都用同一题型。" };
  }
  if (word.has_useful_derivation && !roundTypes.includes("derivation") && index === 1) {
    return { activity: "derivation", reason: "词条有实用派生形式，安排一道词形任务。" };
  }

  const activity = defaultActivity(word, index);
  if (activityAllowed(word, activity)) return { activity, reason: `按 ${word.lesson_profile} 阶段安排短提取。` };
  const fallback = activityAllowed(word, "word_recall") ? "word_recall" : "translation_cn_to_en";
  return {
    activity: fallback,
    reason: `题目适用性优先：${activity} 当前缺少适用内容，改用 ${fallback}。`,
    exception: "题目适用性限制了最近 20 道题的覆盖目标；本次保留目标词与学习进度。",
  };
}

/**
 * Select and freeze one server-owned primary exercise plan per queued word.
 * Skill estimates are inputs; this function remains the sole final activity
 * planner. Supplying an OATutor/BKT adapter in a future version must replace
 * the corresponding signal policy here rather than add a competing planner.
 */
export function planLessonRound(input: ExercisePlannerInput): LessonExercisePlan[] {
  const id = input.id_factory ?? (() => globalThis.crypto.randomUUID());
  const history = recentTypes(input.recent_activities ?? []);
  const roundSize = input.words.length;
  const plans: LessonExercisePlan[] = [];
  const precedingTypes = [...history];

  for (let index = 0; index < input.words.length; index += 1) {
    const word = input.words[index]!;
    const applicableSignals = input.skill_signals?.filter((signal) => !signal.word_id || signal.word_id === word.word_id) ?? [];
    const selected = selectActivity(word, index, roundSize, precedingTypes, applicableSignals);
    const primarySkills = skillIdsFor(word, selected.activity, applicableSignals);
    const signals = input.skill_signals?.filter((signal) => (!signal.word_id || signal.word_id === word.word_id)
      && primarySkills.includes(signal.skill_id))
      ?? deterministicSkillSignals(word);
    const activity = selected.activity;
    const plan = lessonExercisePlanSchema.parse({
      plan_version: 1,
      plan_id: id(),
      exercise_id: id(),
      scope: "lesson",
      word_id: word.word_id,
      target_word_ids: [word.word_id],
      target_sense: word.target_sense,
      planned_activity_type: activity,
      skill_goal: word.error_focus ? `修复 ${word.error_focus} 错误` : activity === "translation_cn_to_en"
        ? "从指定中文核心义主动提取目标词及其用法"
        : activity === "collocation" ? "在具体语境中提取自然搭配"
          : activity === "derivation" ? "识别目标词的常用派生形式"
            : "无提示提取目标词的指定核心义",
      error_focus: word.error_focus,
      skill_ids: primarySkills,
      skill_signals: signals,
      hint_level: activity === "translation_cn_to_en" ? "meaning" : activity === "collocation" ? "context" : "none",
      estimated_seconds: estimatedSeconds(activity),
      selection_reason: selected.reason,
      ...(selected.exception ? { coverage_exception_reason: selected.exception } : {}),
    });
    plans.push(plan);
    precedingTypes.push(activity);
  }

  const normalPlans = plans.filter((plan) => input.words[plans.indexOf(plan)] && isOrdinary(input.words[plans.indexOf(plan)]!));
  const roundActivityTypes = new Set(normalPlans.map((plan) => plan.planned_activity_type));
  if (normalPlans.length > 1 && roundActivityTypes.size < 2) {
    for (const plan of normalPlans) {
      plan.coverage_exception_reason = "专项错误或题目适用性优先，本轮无法加入第二类合适任务。";
    }
  }
  return plans;
}

export function isRetrievalActivity(activity: string): boolean {
  return extractionActivities.has(activity as PlannedActivityType);
}

/**
 * Build the four frozen consolidation choices used by the cadence transaction.
 * The database only indexes this planner-produced list using its durable
 * cursor; it does not invent an activity. Keeping the cursor mapping here
 * makes this the sole final activity-selection policy.
 */
export function cadenceCandidatePlans(plan: LessonExercisePlan, word: string): Record<string, unknown> {
  const target = plan.word_id ?? plan.target_word_ids[0];
  if (!target) return {};
  const make = (activity: "translation_en_to_cn" | "translation_cn_to_en" | "sentence", skill_ids: string[], hint_level: "meaning" | "context") => {
    const taskPlan: LessonExercisePlan = {
      plan_version: 1,
      plan_id: globalThis.crypto.randomUUID(),
      exercise_id: globalThis.crypto.randomUUID(),
      scope: "consolidation",
      word_id: target,
      target_word_ids: [target],
      target_sense: plan.target_sense,
      planned_activity_type: activity,
      skill_goal: activity === "translation_en_to_cn"
        ? skill_ids.includes("relative_clause_attachment")
          ? "识别关系从句的修饰范围并准确翻译"
          : "识别让步结构与逻辑范围并准确翻译"
        : activity === "translation_cn_to_en" ? "从自然中文语境提取目标词义并尝试自然搭配" : "在具体情境中有提示地应用目标词",
      error_focus: plan.error_focus,
      skill_ids,
      hint_level,
      estimated_seconds: 120,
      selection_reason: "每累计 10 个不同 Lesson 词轮换一次的跨天综合任务。",
    };
    const kind = activity === "translation_en_to_cn" ? "translation" : activity;
    return { plan: taskPlan, kind, target_words: [word] };
  };
  return {
    "0": make("translation_en_to_cn", ["relative_clause_attachment"], "meaning"),
    "1": make("translation_cn_to_en", ["target_sense_retrieval", "verb_object_collocation"], "meaning"),
    "2": make("translation_en_to_cn", ["concession_scope"], "meaning"),
    "3": make("sentence", ["target_word_application"], "context"),
  };
}

export function consolidationActivityForCursor(cursor: number): "translation_en_to_cn" | "translation_cn_to_en" | "sentence" {
  const rotation = ["translation_en_to_cn", "translation_cn_to_en", "translation_en_to_cn", "sentence"] as const;
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error("LESSON_CADENCE_CURSOR_INVALID");
  return rotation[cursor % rotation.length]!;
}

export interface ShortTaskCoverage {
  count: number;
  translations: number;
  activity_types: string[];
  retrieval_count: number;
  exceptions: string[];
  meets_initial_targets: boolean;
}

/** Evaluate exactly the recent bounded window used by the planner. */
export function summarizeShortTaskCoverage(
  activities: readonly { activity_type: string; coverage_exception_reason?: string | null }[],
): ShortTaskCoverage {
  const window = activities.slice(-20);
  const translations = window.filter((item) => item.activity_type === "translation_cn_to_en").length;
  const types = [...new Set(window.map((item) => item.activity_type))].sort();
  const retrieval_count = window.filter((item) => isRetrievalActivity(item.activity_type)).length;
  const exceptions = window.flatMap((item) => item.coverage_exception_reason ? [item.coverage_exception_reason] : []);
  return {
    count: window.length,
    translations,
    activity_types: types,
    retrieval_count,
    exceptions,
    meets_initial_targets: window.length < 20 || (translations >= 2 && types.length >= 3 && retrieval_count <= 15),
  };
}

/** Build frozen plans from only the queued words and a bounded event window. */
export async function planLessonQueue(
  queue: readonly string[],
  relearnWords: readonly string[],
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
  options: {
    id_factory?: () => string;
    skill_signals?: readonly SkillSignal[];
    preserve_existing_activity?: { index: number; activity_type: string };
  } = {},
): Promise<LessonExercisePlan[]> {
  if (queue.length < 1 || queue.length > 200) throw new Error("LESSON_QUEUE_INVALID");
  const items = await getVocabularyItemsByWords([...queue], db, userId);
  const byWord = new Map(items.map((item) => [normalizeWord(item.word), item]));
  const relearn = new Set(relearnWords.map(normalizeWord));
  const plannerWords = queue.map((word) => {
    const item = byWord.get(normalizeWord(word));
    if (!item?.word_id) throw new Error("LESSON_PLAN_WORD_MISSING");
    const targetSense = item.senses?.map((sense) => sense.definition_cn.trim()).filter(Boolean).join("；").slice(0, 240);
    if (!targetSense) throw new Error("LESSON_PLAN_SENSE_MISSING");
    const profile = deriveLessonProfile({
      status: item.status,
      is_relearn: relearn.has(normalizeWord(word)),
      error_layers: item.error_layers,
    });
    return {
      word_id: item.word_id,
      word: item.word,
      target_sense: targetSense,
      part_of_speech: item.senses?.find((sense) => sense.pos.trim())?.pos,
      lesson_profile: profile.lesson_profile,
      error_focus: profile.error_focus,
      is_relearn: relearn.has(normalizeWord(word)),
    } satisfies PlannerWord;
  });
  const { data, error } = await db.from("exercise_submission_events")
    .select("exercise_id,scope,activity_type,error_focus,coverage_exception_reason,created_at")
    .eq("user_id", userId)
    .eq("scope", "lesson")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(`LESSON_PLAN_HISTORY_READ_FAILED: ${error.message}`);
  const seen = new Set<string>();
  const recent = ((data ?? []) as Array<{
    exercise_id?: string | null;
    scope: RecentPlannedActivity["scope"];
    activity_type: string;
    error_focus?: ActiveErrorLayer | null;
    coverage_exception_reason?: string | null;
  }>).filter((event) => {
    if (event.exercise_id && seen.has(event.exercise_id)) return false;
    if (event.exercise_id) seen.add(event.exercise_id);
    return true;
  }).slice(0, 20).map((event) => ({
    scope: event.scope,
    activity_type: event.activity_type,
    error_focus: event.error_focus,
    exception_reason: event.coverage_exception_reason,
  }));
  const plans = planLessonRound({
    words: plannerWords,
    recent_activities: recent,
    ...(options.skill_signals ? { skill_signals: options.skill_signals } : {}),
    ...(options.id_factory ? { id_factory: options.id_factory } : {}),
  });
  const preserve = options.preserve_existing_activity;
  const activity = preserve ? plannedActivityTypeSchema.safeParse(preserve.activity_type) : null;
  if (preserve && activity?.success && plans[preserve.index]) {
    const plan = plans[preserve.index]!;
    const skill = activity.data === "spelling" ? "target_word_spelling"
      : activity.data === "collocation" ? collocationSkill(plannerWords[preserve.index]?.part_of_speech)
        : activity.data === "derivation" ? "morphological_family"
          : activity.data === "sentence" || activity.data === "semantic_expression" ? "target_word_application"
            : activity.data === "translation_en_to_cn" ? "sentence_structure" : "target_sense_retrieval";
    plans[preserve.index] = lessonExercisePlanSchema.parse({
      ...plan,
      planned_activity_type: activity.data,
      skill_ids: [skill],
      skill_goal: "沿用旧会话已显示题目并补齐技能证据关联",
      hint_level: activity.data === "sentence" ? "context" : activity.data === "translation_cn_to_en" ? "meaning" : "none",
      selection_reason: "旧会话兼容：保留当前已显示题目；新规划从下一轮生效。",
      coverage_exception_reason: "当前题已显示，恢复时保留题型以避免替换题目。",
    });
  }
  return plans;
}
