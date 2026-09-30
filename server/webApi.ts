import { z } from "zod";
import { getAuthenticatedUserId, getDatabase, getWordloopWebToken } from "./db.js";
import { getStudyBootstrap } from "./services/studyBootstrap.js";
import { getProgress } from "./services/progress.js";
import { AnalyticsServiceError, getAnalytics, getTodayOverview } from "./services/analytics.js";
import {
  advanceStudySessionIfRevision,
  assertActiveStudySessionRevision,
  finishStudySession,
  getActiveStudySession,
  getPretestResults,
  getStudyDate,
  isCompletedLessonRound,
  makeStudyState,
  normalizeLegacyLessonSession,
  normalizeStudyStateForRead,
  markPretestFamiliar,
  persistStudyStateIfRevision,
  recordPlannedSubmission,
  StaleStudyStateError,
} from "./services/studySessions.js";
import { decideLessonConsolidation, getLessonCadence, type ConsolidationKind, type PendingLessonTask } from "./services/lessonConsolidation.js";
import {
  buildLessonNavigation,
  buildLessonWords,
  isLessonCursorAtCurrentWord,
  lessonWordAt,
  lessonWordIndex,
  lessonProgressLabel,
  reconcileLessonQueueAfterCursor,
} from "./services/lessonQueue.js";
import { getTodayWords, getVocabularyItemsByWords, recordPretestResult, setDailyNewWordLimit } from "./services/words.js";
import { formatMeaningByPartOfSpeech, formatPartOfSpeech } from "../shared/lexicalDisplay.js";
import { buildReviewWidgetPayload } from "./tools/renderWidgets.js";
import { getPronunciationAudio } from "./tools/getPronunciationAudio.js";
import { getCompletedLessonWords, recordAttempt } from "./services/attempts.js";
import { recordReviewSubmission } from "./services/fsrsReviews.js";
import {
  assertGradeInvariants,
  gradeExactCloze,
  gradeExactRecall,
  gradeSemanticAnswer as buildSemanticGrade,
  gradeTargetWord,
  gradingRouteForDirection,
} from "../web/src/grading/deterministic.js";
import {
  lessonNavigationSchema,
  pretestMarkFamiliarSchema,
  lessonExercisePlanSchema,
  recordReviewSubmissionSchema,
  reviewWidgetItemSchema,
  setDailyNewWordLimitSchema,
  type ReviewWidgetItem,
} from "../shared/toolContracts.js";
import type { StudySessionRow, StudyState, VocabularyItem } from "./types.js";
import {
  DeepSeekError,
  generateLesson,
  generatePlannedConsolidation,
  generateSentenceConsolidation,
  generateWrapup,
  gradeEnglishDefinition,
  gradeSemanticAnswer as requestSemanticGrade,
  gradeWrapupAnswer,
  type LessonGeneration,
  type SemanticGrade,
  type WrapupGrade,
} from "./services/deepseek.js";
import { normalizeWord } from "./services/wordNormalization.js";
import { deriveLessonProfile } from "./services/lessonProfile.js";
import { cadenceCandidatePlans, planLessonQueue } from "./services/exercisePlanner.js";
import { plannedSkillEvidence } from "./services/plannedSubmission.js";
import {
  addCaptureNoteToLearning,
  createCaptureNote,
  getCaptureNoteById,
  listCaptureNoteOccurrences,
  listCaptureNotes,
  updateCaptureNote,
  CaptureServiceError,
  type CaptureNote,
} from "./services/captureNotes.js";
import {
  captureCreateRequestSchema,
  captureListRequestSchema,
  captureUpdateRequestSchema,
} from "../shared/captureContracts.js";
import { analyticsQuerySchema } from "../shared/analyticsContracts.js";
import { vocabularyQuerySchema } from "../shared/analyticsContracts.js";
import { VocabularyServiceError, getVocabularyDetail, listVocabulary } from "./services/vocabulary.js";

const expectedRevisionSchema = z.string().trim().min(1).nullable();
const mutationBase = { expected_revision: expectedRevisionSchema };
const webActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_daily_new_word_limit"), ...setDailyNewWordLimitSchema.shape, ...mutationBase }).strict(),
  z.object({ action: z.literal("continue"), ...mutationBase }).strict(),
  z.object({ action: z.literal("review_submit"), answer: z.string().max(4000), mark_unknown: z.boolean().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("pretest_submit"), answer: z.string().max(2000), mark_unknown: z.boolean().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("pretest_continue"), current_index: z.number().int().min(0).max(6), expected_revision: z.string().trim().min(1).max(80) }).strict(),
  pretestMarkFamiliarSchema,
  z.object({ action: z.literal("lesson_start_exercise"), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_submit"), answer: z.string().trim().min(1).max(4000), submission_id: z.string().uuid().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_retry"), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_next"), ...mutationBase }).strict(),
  z.object({ action: z.literal("consolidation_start"), ...mutationBase }).strict(),
  z.object({ action: z.literal("consolidation_submit"), answer: z.string().trim().min(1).max(4000), submission_id: z.string().uuid().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("consolidation_defer"), ...mutationBase }).strict(),
  z.object({ action: z.literal("consolidation_retry"), ...mutationBase }).strict(),
  z.object({ action: z.literal("consolidation_finish"), ...mutationBase }).strict(),
  // Accept the previous standalone action names while clients update; state still
  // has to carry an explicit server-issued consolidation marker.
  z.object({ action: z.literal("wrapup_submit"), answer: z.string().trim().min(1).max(4000), submission_id: z.string().uuid().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("wrapup_retry"), ...mutationBase }).strict(),
  z.object({ action: z.literal("wrapup_finish"), ...mutationBase }).strict(),
  z.object({ action: z.literal("refresh_progress"), ...mutationBase }).strict(),
]);

type WebAction = z.output<typeof webActionSchema>;
type Screen = "review" | "pretest" | "lesson" | "done";

class WebApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "WebApiError";
  }
}

export function jsonApiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function legacyCaptureResponse(note: CaptureNote) {
  return {
    ...note,
    status: note.status === "learning" ? "converted" : note.status === "archived" ? "dismissed" : note.status,
    converted_user_word_id: note.user_word_id,
    occurrences: note.occurrences.map((occurrence) => ({ ...occurrence, captured_at: occurrence.created_at })),
  };
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function tokensEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function authenticate(request: Request): void {
  const expected = getWordloopWebToken();
  if (!expected) throw new WebApiError(503, "WEB_TOKEN_NOT_CONFIGURED", "Web access is not configured.");
  const supplied = bearerToken(request);
  if (!supplied || !tokensEqual(supplied, expected)) {
    throw new WebApiError(401, "UNAUTHORIZED", "Unauthorized.");
  }
}

function toApiError(error: unknown): WebApiError {
  if (error instanceof WebApiError) return error;
  if (error instanceof CaptureServiceError) return new WebApiError(error.status, error.code, error.message);
  if (error instanceof AnalyticsServiceError) return new WebApiError(error.status, error.code, error.message);
  if (error instanceof VocabularyServiceError) return new WebApiError(error.status, error.code, error.message);
  if (error instanceof DeepSeekError) return new WebApiError(error.status, error.code, error.message);
  if (error instanceof StaleStudyStateError || (error instanceof Error && ["STALE_STUDY_STATE", "STUDY_SESSION_REVISION_MISMATCH"].includes(error.message))) {
    return new WebApiError(409, "STALE_STUDY_STATE", "Study state changed in another client.");
  }
  const message = error instanceof Error ? error.message : "";
  if ([
    "PRETEST_SESSION_NOT_ACTIVE",
    "PRETEST_FAMILIAR_SOURCE_NOT_ALLOWED",
    "PRETEST_FAMILIAR_CURSOR_MISMATCH",
    "PRETEST_FAMILIAR_ALREADY_KNOWN",
    "PRETEST_FAMILIAR_RESULT_NOT_ELIGIBLE",
    "PRETEST_WORD_NOT_FOUND",
  ].includes(message)) {
    return new WebApiError(409, "INVALID_STUDY_STATE", "The current Pretest result cannot perform this action.");
  }
  if (message === "NO_ACTIVE_SESSION" || /No resumable active study session|No active study session/.test(message)) {
    return new WebApiError(409, "NO_ACTIVE_SESSION", "There is no active study session.");
  }
  if (["LESSON_QUEUE_MISSING", "LESSON_CURSOR_MISMATCH", "LESSON_WRAPUP_NOT_READY", "LESSON_WRAPUP_NOT_COMPLETE", "INVALID_STUDY_STATE"].includes(message)) {
    return new WebApiError(409, message, "The current study state cannot perform this action.");
  }
  if (message === "LESSON_WORD_NOT_FOUND" || message === "LESSON_WORD_MISMATCH") {
    return new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The Lesson queue no longer matches the active word.");
  }
  if (message === "CAPTURE_NOT_FOUND") {
    return new WebApiError(404, "CAPTURE_NOT_FOUND", "这条划词笔记不存在或已被移除。");
  }
  if (message === "CAPTURE_NOT_LEARNABLE") {
    return new WebApiError(409, "CAPTURE_NOT_LEARNABLE", "当前只把单词或两词短语加入现有 WordLoop 学习队列；更长表达先保留在笔记库。");
  }
  console.error("WordLoop Web API request failed", {
    code: "INTERNAL_SERVER_ERROR",
    error_type: error instanceof Error ? error.name : "unknown",
  });
  return new WebApiError(500, "INTERNAL_SERVER_ERROR", "请求未完成，请重试。");
}

function failure(error: unknown): Response {
  const apiError = toApiError(error);
  return jsonApiResponse({ error: { code: apiError.code, message: apiError.message } }, apiError.status);
}

function ensureState(session: StudySessionRow | null): StudyState {
  if (!session?.state) throw new WebApiError(409, "INVALID_STUDY_STATE", "The active study state is unavailable.");
  return normalizeStudyStateForRead(session.state);
}

function persistedMeaning(item: VocabularyItem): string {
  return formatMeaningByPartOfSpeech(item.senses);
}

export function buildPretestItems(words: VocabularyItem[]): Array<Record<string, unknown>> {
  if (words.length === 0) throw new WebApiError(409, "INVALID_STUDY_STATE", "The pretest queue is empty.");
  return words.map((item) => {
    const meaning = persistedMeaning(item);
    if (!meaning) throw new WebApiError(409, "INVALID_STUDY_STATE", "A pretest word has no saved Chinese meaning.");
    return {
      word: item.word,
      ipa: item.ipa_us?.trim() || "—",
      part_of_speech: formatPartOfSpeech(item.senses) ?? "词性未标注",
      meaning_zh: meaning,
      prompt: meaning,
      direction: "cn_to_en",
    };
  });
}

function resultForState(
  session: StudySessionRow,
  state = ensureState(session),
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const screen: Screen = state.widget === "dictation" ? "done" : state.widget;
  let responseState = state;
  if (state.widget === "lesson") {
    const payload = { ...state.payload };
    delete payload.accepted_answers;
    if (typeof payload.feedback === "object" && payload.feedback !== null && !Array.isArray(payload.feedback)) {
      const feedback = { ...payload.feedback as Record<string, unknown> };
      if (feedback.reveal_answer !== true) delete feedback.reference_answer;
      if (Array.isArray(feedback.target_word_results)) {
        feedback.target_word_results = feedback.target_word_results.map((result) => {
          if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
          const safeResult = { ...result as Record<string, unknown> };
          delete safeResult.reference_expression;
          return safeResult;
        });
      }
      payload.feedback = feedback;
    }
    if (typeof payload.plan === "object" && payload.plan !== null && !Array.isArray(payload.plan)) {
      const plan = { ...payload.plan as Record<string, unknown> };
      delete plan.target_sense;
      delete plan.word_id;
      delete plan.target_word_ids;
      delete plan.skill_signals;
      payload.plan = plan;
    }
    if (typeof payload.consolidation_plan === "object" && payload.consolidation_plan !== null && !Array.isArray(payload.consolidation_plan)) {
      const plan = { ...payload.consolidation_plan as Record<string, unknown> };
      delete plan.target_sense;
      delete plan.word_id;
      delete plan.target_word_ids;
      delete plan.skill_signals;
      payload.consolidation_plan = plan;
    }
    delete payload.resume_state;
    if (typeof payload.exercise === "object" && payload.exercise !== null && !Array.isArray(payload.exercise)) {
      const exercise = { ...payload.exercise as Record<string, unknown> };
      delete exercise.accepted_answers;
      payload.exercise = exercise;
    }
    const concealTarget = state.phase === "lesson_exercise" && state.payload.consolidation !== true;
    let responseFlow = state.flow;
    let currentWord = state.current_word;
    if (concealTarget) {
      delete payload.word;
      delete payload.ipa;
      delete payload.meaning_zh;
      delete payload.example_en;
      delete payload.example_zh;
      if (typeof payload.navigation === "object" && payload.navigation !== null) {
        const navigation = payload.navigation as Record<string, unknown>;
        payload.navigation = { action: navigation.action, next_index: navigation.next_index };
      }
      responseFlow = {
        relearn_words: [],
        ...(state.flow.lesson_words ? { lesson_words: state.flow.lesson_words.map(() => "__hidden_lesson_word__") } : {}),
      };
      currentWord = null;
    }
    responseState = { ...state, current_word: currentWord, flow: responseFlow, payload };
  }
  return {
    screen,
    session_revision: session.updated_at,
    state: responseState,
    ...(state.widget === "dictation" ? { message: "当前学习流程正在 ChatGPT 听写阶段，请在 ChatGPT 完成此阶段。" } : {}),
    ...extra,
  };
}

async function progressIfAvailable(): Promise<unknown | undefined> {
  try {
    return await getProgress();
  } catch {
    console.error("WordLoop progress failed", { source: "bootstrap" });
    return undefined;
  }
}

async function pronunciationUrl(word: string | null): Promise<string | null> {
  if (!word) return null;
  try {
    const result = await getPronunciationAudio([word]);
    return result.words.find((entry) => normalizeWord(entry.word) === normalizeWord(word))?.audio_url ?? null;
  } catch {
    return null;
  }
}

async function successForSession(
  session: StudySessionRow,
  extra: Record<string, unknown> = {},
  audioUrl?: string | null,
): Promise<Record<string, unknown>> {
  const state = ensureState(session);
  const response = resultForState(session, state, extra);
  if (state.widget === "lesson") response.pronunciation_audio_url = state.phase === "lesson_explain" && state.payload.mode === "explain"
    ? audioUrl === undefined ? await pronunciationUrl(state.current_word) : audioUrl
    : null;
  if (state.widget === "pretest" && (state.phase === "pretest_result" || state.phase === "pretest_complete")) {
    const results = await getPretestResults(session);
    response.pretest_results = results;
    if (state.phase === "pretest_result") {
      response.pretest_result = results.find((result) => normalizeWord(result.word) === normalizeWord(state.current_word ?? ""));
    } else {
      const counts = { known: 0, uncertain: 0, unknown: 0 };
      for (const result of results) {
        if (result.status === "known" || result.status === "uncertain" || result.status === "unknown") counts[result.status] += 1;
      }
      response.pretest_summary = counts;
    }
  }
  const progress = await progressIfAvailable();
  if (progress !== undefined) response.progress = progress;
  response.pending_consolidation = await pendingConsolidationSummary();
  return response;
}

async function pendingConsolidationSummary(): Promise<Record<string, unknown> | null> {
  const cadence = await getLessonCadence();
  const pending = cadence.pending_task;
  if (!pending) return null;
  const activity = pending.plan.planned_activity_type;
  const label = activity === "translation_en_to_cn" ? "长难句英译中"
    : activity === "translation_cn_to_en" ? "完整中译英"
      : activity === "sentence" ? "情境造句"
        : activity === "collocation" ? "搭配练习" : "应用巩固";
  return { activity_type: activity, label, estimated_seconds: pending.plan.estimated_seconds };
}

async function doneResponse(revision: string | null = null): Promise<Record<string, unknown>> {
  return {
    screen: "done",
    session_revision: revision,
    state: {},
    progress: await getProgress(),
    pending_consolidation: await pendingConsolidationSummary(),
  };
}

/** Normalize old session payloads before the bootstrap path can persist anything. */
async function prepareBootstrap(expectedRevision?: string | null): Promise<{
  bootstrap: Awaited<ReturnType<typeof getStudyBootstrap>>;
  active: StudySessionRow | null;
  revision: string | null;
}> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  let active = await getActiveStudySession(db, userId);
  let revision = active?.updated_at ?? null;
  if (expectedRevision !== undefined && revision !== expectedRevision) throw new StaleStudyStateError();
  if (active?.state) {
    let state = normalizeStudyStateForRead(active.state);
    if (state.widget === "lesson" && state.flow.lesson_words === undefined) {
      active = await normalizeLegacyLessonSession(active, db, userId, revision);
      revision = active.updated_at;
      state = normalizeStudyStateForRead(active.state!);
    }
    if (state.widget === "lesson" && state.flow.lesson_words !== undefined && state.phase !== "lesson_complete") {
      const completedBeforeSession = await getCompletedLessonWords(db, userId, active.started_at);
      const reconciled = reconcileLessonQueueAfterCursor({
        lessonWords: state.flow.lesson_words,
        currentIndex: state.current_index,
        completedLessonWords: completedBeforeSession,
        relearnWords: state.flow.relearn_words,
        skipCompletedCurrent: state.phase === "lesson_explain",
      });
      if (reconciled?.changed) {
        const nextFlow = { ...state.flow, lesson_words: reconciled.lessonWords };
        const nextState = {
          ...state,
          current_word: reconciled.currentWord,
          current_index: reconciled.currentIndex,
          flow: nextFlow,
        };
        if (reconciled.skippedCurrent) {
          const regenerated = await generateAndPersistLesson({
            word: reconciled.currentWord,
            date: state.date,
            flow: nextFlow,
            index: reconciled.currentIndex,
            expectedRevision: revision,
            sessionId: active.id,
          });
          active = regenerated.session;
        } else {
          const currentWord = reconciled.currentWord;
          nextState.payload = {
            ...state.payload,
            progress: lessonProgressLabel(state.flow.relearn_words, reconciled.lessonWords, reconciled.currentIndex),
            navigation: buildLessonNavigation(reconciled.lessonWords, reconciled.currentIndex, currentWord),
          };
          active = await persistStudyStateIfRevision(nextState, revision, db, userId, active.id);
        }
        revision = active.updated_at;
      }
    }
  } else if (active) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The active study state is unavailable.");
  }

  const bootstrap = await getStudyBootstrap({
    activeSession: active,
    expectedRevision: revision,
    deferLessonQueueFreeze: true,
  });
  const latest = await getActiveStudySession(db, userId);
  if ((latest?.id ?? null) !== (active?.id ?? null)
    || (latest?.updated_at ?? null) !== revision) throw new StaleStudyStateError();
  return { bootstrap, active: latest, revision };
}

async function persistPretest(
  words: VocabularyItem[],
  active: StudySessionRow | null,
  expectedRevision: string | null,
): Promise<StudySessionRow> {
  const items = buildPretestItems(words);
  const firstWord = String(items[0]?.word ?? "");
  const prior = active?.state ? normalizeStudyStateForRead(active.state) : null;
  const flow = prior?.flow ?? { relearn_words: [] };
  const state = makeStudyState({
    date: prior?.date ?? await getStudyDate(),
    widget: "pretest",
    phase: "pretest",
    current_word: firstWord,
    current_index: 0,
    retry_count: 0,
    flow: { relearn_words: flow.relearn_words },
    payload: { widget: "pretest", title: "快速预测试", items },
  });
  return persistStudyStateIfRevision(state, expectedRevision, getDatabase(), getAuthenticatedUserId(), active?.id);
}

function lessonWordFromBootstrap(value: { word: VocabularyItem }): string {
  return value.word.word;
}

async function generateAndPersistLesson(input: {
  word: string;
  date: string;
  flow: StudyState["flow"];
  index: number;
  expectedRevision: string | null;
  sessionId?: string;
}): Promise<{ session: StudySessionRow; audioUrl: string | null }> {
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  const [item] = await getVocabularyItemsByWords([input.word], db, userId);
  if (!item) throw new WebApiError(409, "LESSON_WORD_NOT_FOUND", "The queued Lesson word is unavailable.");
  const meaning = persistedMeaning(item);
  if (!meaning) throw new WebApiError(409, "INVALID_STUDY_STATE", "The queued Lesson word has no saved Chinese meaning.");
  const persistedPos = formatPartOfSpeech(item.senses);
  const pos = persistedPos ?? "未标注词性";
  const savedProfile = input.flow.lesson_profile_history?.find((entry) => normalizeWord(entry.word) === normalizeWord(item.word));
  const lessonProfile = savedProfile
    ? { lesson_profile: savedProfile.lesson_profile, error_focus: savedProfile.error_focus }
    : deriveLessonProfile({
      status: item.status,
      is_relearn: input.flow.relearn_words.some((word) => normalizeWord(word) === normalizeWord(item.word)),
      error_layers: item.error_layers,
    });
  const lessonProfileHistory = [
    ...(input.flow.lesson_profile_history ?? []).filter((entry) => normalizeWord(entry.word) !== normalizeWord(item.word)),
    { word: item.word, ...lessonProfile },
  ];
  const queue = input.flow.lesson_words;
  if (!queue || queue.length === 0 || !isLessonCursorAtCurrentWord(queue, item.word, input.index)) {
    throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The Lesson queue no longer matches the active word.");
  }
  const plannedFlow = input.flow.exercise_plans?.length === queue.length
    ? input.flow
    : { ...input.flow, exercise_plans: await planLessonQueue(queue, input.flow.relearn_words, db, userId) };
  const plan = plannedFlow.exercise_plans?.[input.index];
  if (!plan || plan.scope !== "lesson" || plan.word_id !== item.word_id) {
    throw new WebApiError(409, "LESSON_PLAN_MISMATCH", "The saved Lesson plan does not match the active word.");
  }
  let expectedRevision = input.expectedRevision;
  let sessionId = input.sessionId;
  const existing = await assertActiveStudySessionRevision(expectedRevision, sessionId, db, userId);
  const generationState = makeStudyState({
    date: input.date,
    widget: "lesson",
    phase: "lesson_explain",
    current_word: item.word,
    current_index: input.index,
    retry_count: 0,
    flow: { ...plannedFlow, lesson_profile_history: lessonProfileHistory },
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "generation_error",
      word: item.word,
      lesson_profile: lessonProfile.lesson_profile,
      error_focus: lessonProfile.error_focus,
      plan,
      progress: lessonProgressLabel(plannedFlow.relearn_words, queue, input.index),
    },
  });
  const plannedSession = await persistStudyStateIfRevision(generationState, expectedRevision, db, userId, existing?.id ?? sessionId);
  expectedRevision = plannedSession.updated_at;
  sessionId = plannedSession.id;
  const [generated, audioUrl] = await Promise.all([
    generateLesson({
      word: item.word,
      meaning_zh: meaning,
      part_of_speech: pos,
      ...(item.ipa_us?.trim() ? { ipa: item.ipa_us.trim() } : {}),
      ...lessonProfile,
      plan,
    }),
    pronunciationUrl(item.word),
  ]);
  const navigation = buildLessonNavigation(queue, input.index, item.word);
  await assertActiveStudySessionRevision(expectedRevision, sessionId, db, userId);
  const state = makeStudyState({
    date: input.date,
    widget: "lesson",
    phase: "lesson_explain",
    current_word: item.word,
    current_index: input.index,
    retry_count: 0,
    flow: { ...plannedFlow, lesson_profile_history: lessonProfileHistory },
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "explain",
      ...lessonProfile,
      plan,
      word: item.word,
      progress: lessonProgressLabel(input.flow.relearn_words, queue, input.index),
      ipa: generated.ipa,
      part_of_speech: persistedPos ?? generated.part_of_speech,
      meaning_zh: meaning,
      collocations: generated.collocations,
      derivations: generated.derivations,
      example_en: generated.example_en,
      example_zh: generated.example_zh,
      note: generated.note,
      exercise: generated.exercise,
      ...(generated.exercise.accepted_answers ? { accepted_answers: generated.exercise.accepted_answers } : {}),
      navigation,
    },
  });
  const session = await persistStudyStateIfRevision(state, expectedRevision, db, userId, sessionId);
  return { session, audioUrl };
}

async function createLessonFromBootstrap(
  bootstrap: Extract<Awaited<ReturnType<typeof getStudyBootstrap>>, { action: "lesson" }>,
  active: StudySessionRow | null,
  revision: string | null,
): Promise<{ session: StudySessionRow; audioUrl: string | null }> {
  const requestedWord = lessonWordFromBootstrap(bootstrap);
  const db = getDatabase();
  const userId = getAuthenticatedUserId();
  if (active?.state) {
    const state = normalizeStudyStateForRead(active.state);
    if (state.widget !== "pretest" && state.widget !== "review") {
      throw new WebApiError(409, "INVALID_STUDY_STATE", "The active study session cannot start a Lesson.");
    }
    let lessonWords = bootstrap.lesson_words ?? state.flow.lesson_words;
    if (!lessonWords) {
      const [todayWords, completedLessonWords] = await Promise.all([
        getTodayWords(state.date, db, userId),
        getCompletedLessonWords(db, userId),
      ]);
      lessonWords = buildLessonWords(
        state.flow.relearn_words,
        todayWords,
        completedLessonWords,
        state.flow.pretest_familiar_words,
      );
    }
    const currentFlow = { ...state.flow, lesson_words: lessonWords };
    const firstWord = lessonWordAt(lessonWords ?? [], 0);
    if (!lessonWords || !firstWord || normalizeWord(firstWord) !== normalizeWord(requestedWord)) {
      throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The Lesson word does not match the frozen queue.");
    }
    return generateAndPersistLesson({
      word: firstWord,
      date: state.date,
      flow: currentFlow,
      index: 0,
      expectedRevision: revision,
      sessionId: active.id,
    });
  }

  const date = await getStudyDate(db, userId);
  const [todayWords, completedLessonWords] = await Promise.all([
    getTodayWords(date, db, userId),
    getCompletedLessonWords(db, userId),
  ]);
  const lessonWords = buildLessonWords([], todayWords, completedLessonWords);
  const firstWord = lessonWordAt(lessonWords, 0);
  if (!firstWord || normalizeWord(firstWord) !== normalizeWord(requestedWord)) {
    throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The Lesson word does not match the daily queue.");
  }
  return generateAndPersistLesson({
    word: firstWord,
    date,
    flow: { relearn_words: [], lesson_words: lessonWords },
    index: lessonWordIndex(lessonWords, firstWord),
    expectedRevision: revision,
  });
}

async function resolveBootstrap(expectedRevision?: string | null): Promise<Record<string, unknown>> {
  const prepared = await prepareBootstrap(expectedRevision);
  const { bootstrap, active, revision } = prepared;
  if (bootstrap.action === "resume") {
    if (!active) throw new WebApiError(409, "NO_ACTIVE_SESSION", "There is no active study session to resume.");
    if (active.state?.widget === "lesson" && active.state.payload.mode === "generation_error" && active.state.current_word) {
      return successForSession((await generateAndPersistLesson({
        word: active.state.current_word,
        date: active.state.date,
        flow: active.state.flow,
        index: active.state.current_index,
        expectedRevision: active.updated_at,
        sessionId: active.id,
      })).session);
    }
    const consolidation = active.state?.widget === "lesson" ? lessonConsolidation(active.state) : null;
    if (active.state?.phase === "lesson_complete" && consolidation?.consolidation_status === "pending") {
      return successForSession(active);
    }
    return successForSession(active);
  }
  if (bootstrap.action === "review") {
    await buildReviewWidgetPayload(0, revision);
    const session = await getActiveStudySession();
    if (!session?.state || session.state.widget !== "review") throw new WebApiError(409, "INVALID_STUDY_STATE", "The review session could not be created.");
    return successForSession(session);
  }
  if (bootstrap.action === "pretest") {
    const session = await persistPretest(bootstrap.words, active, revision);
    return successForSession(session);
  }
  if (bootstrap.action === "lesson") {
    const result = await createLessonFromBootstrap(bootstrap, active, revision);
    return successForSession(result.session, {}, result.audioUrl);
  }
  return doneResponse(revision);
}

function activeState(active: StudySessionRow | null, widget?: StudyState["widget"]): StudyState {
  const state = ensureState(active);
  if (widget && state.widget !== widget) throw new WebApiError(409, "INVALID_STUDY_STATE", "The active study phase does not match this action.");
  return state;
}

function reviewItemAt(state: StudyState): ReviewWidgetItem {
  const items = z.array(reviewWidgetItemSchema).min(1).max(200).safeParse(state.payload.items);
  if (!items.success) throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved review snapshot is invalid.");
  const item = items.data[state.current_index];
  if (!item || !state.current_word || normalizeWord(item.word) !== normalizeWord(state.current_word)) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved review cursor does not match its card.");
  }
  return item;
}

async function submitReview(action: Extract<WebAction, { action: "review_submit" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "review");
  if (!active || state.phase !== "review") throw new WebApiError(409, "INVALID_STUDY_STATE", "There is no current review card.");
  const item = reviewItemAt(state);
  let grade: ReturnType<typeof gradeTargetWord> | ReturnType<typeof buildSemanticGrade>;
  if (action.mark_unknown) {
    grade = { is_correct: false, error_layer: "meaning", rating: "again", feedback: "已标记为不会。", graded_by: "deterministic" };
  } else if (item.direction === "en_definition") {
    const semantic = await gradeEnglishDefinition({
      word: item.word,
      ...(item.part_of_speech ? { part_of_speech: item.part_of_speech } : {}),
      meaning_zh: item.meaning_zh,
      answer: action.answer,
    });
    grade = buildSemanticGrade({
      isCorrect: semantic.is_correct,
      errorLayer: semantic.is_correct ? "none" : "meaning",
      feedback: semantic.feedback,
      advancesFsrs: true,
    });
  } else {
    grade = gradeTargetWord(action.answer, item.word);
  }
  assertGradeInvariants(grade, {
    activity_type: "review",
    advancesFsrs: true,
    reviewSubmission: true,
    direction: item.direction,
  });
  await assertActiveStudySessionRevision(action.expected_revision, active.id);
  const input = recordReviewSubmissionSchema.parse({
    word: item.word,
    user_answer: action.answer,
    is_correct: grade.is_correct,
    error_layer: grade.error_layer,
    rating: grade.rating,
    direction: item.direction,
    session_id: active.id,
  });
  await recordReviewSubmission(input);
  const updated = await getActiveStudySession();
  if (!updated) return doneResponse(null);
  return successForSession(updated, {
    result: { is_correct: grade.is_correct, error_layer: grade.error_layer, message: grade.feedback },
  });
}

async function submitPretest(action: Extract<WebAction, { action: "pretest_submit" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "pretest");
  if (!active || state.phase !== "pretest" || !state.current_word) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "There is no current pretest question.");
  }
  if (action.expected_revision === null) throw new StaleStudyStateError();
  const items = z.array(z.object({ word: z.string().min(1), meaning_zh: z.string().min(1) })).min(1).max(7).safeParse(state.payload.items);
  if (!items.success) throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved pretest questions are invalid.");
  const item = items.data[state.current_index];
  if (!item || normalizeWord(item.word) !== normalizeWord(state.current_word)) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The pretest cursor does not match its saved question.");
  }
  const grade = action.mark_unknown ? null : gradeExactRecall(action.answer, state.current_word);
  const result = action.mark_unknown ? "unknown" : grade?.rating === "good" ? "known" : grade?.rating === "hard" ? "uncertain" : "unknown";
  await assertActiveStudySessionRevision(action.expected_revision, active.id);
  await recordPretestResult({
    word: state.current_word,
    result,
    user_answer: action.answer,
    activity_type: "pretest_cn_to_en",
  });
  const nextResult = await advanceStudySessionIfRevision("pretest_result", state.current_index, action.expected_revision, active.id);
  return successForSession(nextResult, {
    result: {
      status: result,
      user_answer: action.answer,
      is_correct: grade?.is_correct ?? false,
      error_layer: grade?.error_layer ?? "meaning",
    },
  });
}

async function continuePretest(action: Extract<WebAction, { action: "pretest_continue" }>): Promise<Record<string, unknown>> {
  const active = await getActiveStudySession();
  const state = activeState(active, "pretest");
  if (!active || state.payload.source !== "new_word") {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "There is no current new-word Pretest result.");
  }
  const items = z.array(z.object({ word: z.string().min(1) })).min(1).max(7).safeParse(state.payload.items);
  if (!items.success) throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved Pretest questions are invalid.");
  const itemCount = items.data.length;

  if (active.updated_at !== action.expected_revision) {
    const alreadyAdvanced = state.phase === "pretest" && state.current_index === action.current_index + 1;
    const alreadyCompleted = state.phase === "pretest_complete"
      && state.current_index === itemCount
      && action.current_index === itemCount - 1;
    if (alreadyAdvanced || alreadyCompleted) return successForSession(active);
    throw new StaleStudyStateError();
  }
  if (state.phase !== "pretest_result" || state.current_index !== action.current_index) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "There is no revealed result at this Pretest cursor.");
  }

  const nextIndex = action.current_index + 1;
  const event = nextIndex >= itemCount ? "pretest_complete" : "pretest_question";
  const saved = await advanceStudySessionIfRevision(event, event === "pretest_complete" ? itemCount : nextIndex, action.expected_revision, active.id);
  return successForSession(saved);
}

async function markPretestFamiliarFromWeb(action: Extract<WebAction, { action: "pretest_mark_familiar" }>): Promise<Record<string, unknown>> {
  await markPretestFamiliar(action);
  const updated = await getActiveStudySession();
  if (!updated) throw new WebApiError(409, "INVALID_STUDY_STATE", "The Pretest session is no longer active.");
  return successForSession(updated, { result: { status: "known", mark_familiar: true } });
}

const lessonExerciseSchema = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
});
const lessonConsolidationSchema = z.object({
  consolidation: z.literal(true),
  consolidation_kind: z.enum(["translation", "translation_cn_to_en", "sentence"]),
  consolidation_trigger_round: z.number().int().positive(),
  consolidation_target_words: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
  consolidation_plan: lessonExercisePlanSchema.optional(),
  consolidation_status: z.enum(["pending", "exercise", "feedback", "completed"]),
}).superRefine((value, context) => {
  const validCount = value.consolidation_plan
    ? value.consolidation_target_words.length >= 1 && value.consolidation_target_words.length <= 2
    : value.consolidation_kind === "translation"
      ? value.consolidation_target_words.length >= 2 && value.consolidation_target_words.length <= 3
      : value.consolidation_target_words.length >= 1 && value.consolidation_target_words.length <= 2;
  if (!validCount) context.addIssue({ code: "custom", message: "LESSON_CONSOLIDATION_TARGET_COUNT_INVALID", path: ["consolidation_target_words"] });
  if (value.consolidation_plan && (value.consolidation_plan.scope !== "consolidation"
    || value.consolidation_plan.planned_activity_type !== (value.consolidation_kind === "translation" ? "translation_en_to_cn" : value.consolidation_kind === "translation_cn_to_en" ? "translation_cn_to_en" : "sentence"))) {
    context.addIssue({ code: "custom", message: "LESSON_CONSOLIDATION_PLAN_MISMATCH", path: ["consolidation_plan"] });
  }
});

function lessonConsolidation(state: StudyState) {
  const parsed = lessonConsolidationSchema.safeParse(state.payload);
  return parsed.success ? parsed.data : null;
}

const recordableLessonTypes = new Set([
  "pretest_cn_to_en", "pretest_en_definition", "translation_cn_to_en", "translation_en_to_cn", "cloze",
  "derivation", "listening", "collocation", "sentence", "semantic_expression", "review", "recall",
  "listen_recall", "spelling", "word_recall", "exact_cloze",
]);

function lessonExercise(state: StudyState): z.infer<typeof lessonExerciseSchema> {
  const source = state.payload.mode === "exercise" ? state.payload : state.payload.exercise;
  const parsed = lessonExerciseSchema.safeParse(source);
  if (!parsed.success || !recordableLessonTypes.has(parsed.data.activity_type)) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved Lesson exercise is not supported.");
  }
  const plan = lessonExercisePlanSchema.safeParse(state.payload.plan);
  if (plan.success && parsed.data.activity_type !== plan.data.planned_activity_type) {
    throw new WebApiError(409, "LESSON_PLAN_MISMATCH", "The saved exercise does not match its server plan.");
  }
  return parsed.data;
}

async function savedOrLegacyPlan(
  state: StudyState,
  activityType: string,
  scope: "lesson" | "consolidation",
): Promise<z.infer<typeof lessonExercisePlanSchema>> {
  const saved = lessonExercisePlanSchema.safeParse(state.payload.plan
    ?? (scope === "consolidation" ? state.payload.consolidation_plan : undefined));
  if (saved.success) {
    if (saved.data.scope !== scope || saved.data.planned_activity_type !== activityType) {
      throw new WebApiError(409, "LESSON_PLAN_MISMATCH", "The current exercise no longer matches its saved plan.");
    }
    return saved.data;
  }
  // Legacy active sessions keep their already-rendered prompt. Attach identity
  // and evidence metadata in the same submission commit without regenerating it.
  if (!state.current_word) throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved Lesson word is unavailable.");
  const [item] = await getVocabularyItemsByWords([state.current_word]);
  if (!item?.word_id) throw new WebApiError(409, "LESSON_PLAN_WORD_MISSING", "The saved Lesson word has no durable identity.");
  const supported = lessonExercisePlanSchema.shape.planned_activity_type.safeParse(activityType);
  if (!supported.success) throw new WebApiError(409, "LESSON_PLAN_ACTIVITY_UNSUPPORTED", "The saved exercise type is no longer supported.");
  const skill = activityType === "spelling" ? "target_word_spelling"
    : activityType === "collocation" ? "lexical_collocation"
      : activityType === "derivation" ? "morphological_family"
        : activityType === "sentence" || activityType === "semantic_expression" ? "target_word_application"
          : activityType === "translation_en_to_cn" ? "relative_clause_attachment" : "target_sense_retrieval";
  return lessonExercisePlanSchema.parse({
    plan_version: 1,
    plan_id: globalThis.crypto.randomUUID(),
    exercise_id: globalThis.crypto.randomUUID(),
    scope,
    word_id: item.word_id,
    target_word_ids: [item.word_id],
    target_sense: persistedMeaning(item) || "已学词的核心义",
    planned_activity_type: supported.data,
    skill_goal: "保留旧会话当前题并补齐技能证据关联",
    error_focus: null,
    skill_ids: [skill],
    hint_level: activityType === "sentence" ? "context" : "none",
    estimated_seconds: 30,
    selection_reason: "旧会话兼容：沿用已保存的原题，只补充计划标识。",
  });
}

function savedAcceptedAnswers(state: StudyState): string[] {
  const nestedExercise = typeof state.payload.exercise === "object" && state.payload.exercise !== null
    ? state.payload.exercise as Record<string, unknown>
    : {};
  const accepted = z.array(z.string().trim().min(1).max(200)).max(20)
    .safeParse(state.payload.accepted_answers ?? nestedExercise.accepted_answers);
  return accepted.success ? accepted.data : [];
}

function deterministicLessonGrade(state: StudyState, exercise: z.infer<typeof lessonExerciseSchema>, answer: string) {
  if (!state.current_word) throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson word is unavailable.");
  const route = gradingRouteForDirection(exercise.activity_type);
  if (route === "deterministic_cloze") {
    const accepted = savedAcceptedAnswers(state);
    if (accepted.length === 0) throw new WebApiError(409, "INVALID_STUDY_STATE", "The exact cloze answer is missing from saved state.");
    const grade = gradeExactCloze(answer, accepted);
    const { rating: _rating, ...practiceGrade } = grade;
    return { ...practiceGrade, message: grade.feedback, explanation: grade.is_correct ? "答案与已保存的正确词形一致。" : "核对空格处要求的词形，再试一次。", reference_answer: accepted[0] };
  }
  if (route !== "deterministic") return null;
  const grade = exercise.activity_type === "spelling" || exercise.activity_type === "word_recall"
    ? gradeTargetWord(answer, state.current_word)
    : gradeExactRecall(answer, state.current_word);
  return {
    ...grade,
    message: grade.is_correct ? "答案正确。" : answer.trim() ? `“${answer.trim()}”与目标词不匹配。` : "你还没有输入答案。",
    explanation: grade.is_correct ? "目标词与作答一致。" : "核对目标词的拼写和含义后再试一次。",
    reference_answer: state.current_word,
  };
}

function assertLessonCursor(state: StudyState): string[] {
  const queue = state.flow.lesson_words;
  if (!queue || queue.length === 0) throw new WebApiError(409, "LESSON_QUEUE_MISSING", "The saved Lesson queue is unavailable.");
  if (!state.current_word || !isLessonCursorAtCurrentWord(queue, state.current_word, state.current_index)) {
    throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The saved Lesson cursor does not match its queue.");
  }
  return queue;
}

async function gradeLesson(state: StudyState, exercise: z.infer<typeof lessonExerciseSchema>, answer: string): Promise<{
  is_correct: boolean;
  error_layer: "none" | "meaning" | "collocation" | "grammar" | "spelling" | "pronunciation";
  message: string;
  explanation: string;
  reference_answer?: string;
  graded_by: "deterministic" | "semantic";
  task_fulfillment?: boolean;
  meaning?: SemanticGrade["meaning"];
  collocation?: SemanticGrade["collocation"];
  grammar?: SemanticGrade["grammar"];
  naturalness?: SemanticGrade["naturalness"];
  target_word_results?: SemanticGrade["target_word_results"];
  skill_results?: SemanticGrade["skill_results"];
  error_excerpt?: string;
  short_hint?: string;
}> {
  const deterministic = deterministicLessonGrade(state, exercise, answer);
  if (deterministic) {
    const plan = lessonExercisePlanSchema.safeParse(state.payload.plan);
    if (!plan.success || plan.data.skill_ids.length !== 1) return deterministic;
    return {
      ...deterministic,
      task_fulfillment: deterministic.is_correct,
      target_word_results: [{
        word_id: plan.data.word_id,
        word: state.current_word!,
        outcome: deterministic.is_correct ? "correct" : "incorrect",
        meaning: deterministic.is_correct ? "目标义正确。" : "目标义或词形未通过。",
      }],
      skill_results: [{
        skill_id: plan.data.skill_ids[0]!,
        outcome: deterministic.is_correct ? "correct" : "incorrect",
        evidence: "确定性题型按服务端保存的答案逐字判定。",
      }],
      error_excerpt: deterministic.is_correct ? "" : answer.trim(),
      short_hint: deterministic.explanation,
    };
  }
  if (![
    "translation_cn_to_en", "translation_en_to_cn", "collocation", "sentence", "semantic_expression", "pretest_en_definition",
  ].includes(exercise.activity_type)) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved Lesson exercise does not have a supported grading route.");
  }
  if (!state.current_word) throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson word is unavailable.");
  const semantic: SemanticGrade = await requestSemanticGrade({
    word: state.current_word,
    plan: lessonExercisePlanSchema.safeParse(state.payload.plan).success
      ? lessonExercisePlanSchema.parse(state.payload.plan)
      : undefined,
    activity_type: exercise.activity_type,
    instruction: exercise.instruction,
    prompt: exercise.prompt,
    answer,
    retry_count: state.retry_count,
  });
  if (!semantic.is_correct && semantic.error_layer === "none") {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "DeepSeek output did not satisfy the grading rules.");
  }
  const grade = buildSemanticGrade({
    isCorrect: semantic.is_correct,
    errorLayer: semantic.error_layer,
    feedback: semantic.message,
    advancesFsrs: false,
  });
  assertGradeInvariants(grade, { activity_type: exercise.activity_type, advancesFsrs: false });
  return {
    ...grade,
    message: semantic.message,
    explanation: semantic.explanation,
      ...(semantic.reference_answer ? { reference_answer: semantic.reference_answer } : {}),
      task_fulfillment: semantic.task_fulfillment,
      meaning: semantic.meaning,
      collocation: semantic.collocation,
      grammar: semantic.grammar,
      naturalness: semantic.naturalness,
      target_word_results: semantic.target_word_results,
      skill_results: semantic.skill_results,
      error_excerpt: semantic.error_excerpt,
      short_hint: semantic.short_hint,
  };
}

function lessonFeedbackState(
  state: StudyState,
  exercise: z.infer<typeof lessonExerciseSchema>,
  answer: string,
  grade: Awaited<ReturnType<typeof gradeLesson>>,
): StudyState {
  const queue = assertLessonCursor(state);
  const nextRetry = grade.is_correct ? state.retry_count : state.retry_count + 1;
  const reveal = !grade.is_correct && nextRetry >= 2;
  const exercisePayload = {
    activity_type: exercise.activity_type,
    instruction: exercise.instruction,
    prompt: exercise.prompt,
    multiline: exercise.multiline,
  };
  const navigation = buildLessonNavigation(queue, state.current_index, state.current_word!);
  const referenceAnswer = grade.reference_answer;
  const acceptedAnswers = savedAcceptedAnswers(state);
  const plan = lessonExercisePlanSchema.safeParse(state.payload.plan);
  const consolidation = lessonConsolidation(state);
  return {
    ...state,
    phase: consolidation ? "lesson_complete" : "lesson_feedback",
    retry_count: nextRetry,
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "feedback",
      ...(consolidation ? {
        consolidation: true,
        consolidation_kind: consolidation.consolidation_kind,
        consolidation_trigger_round: consolidation.consolidation_trigger_round,
        consolidation_target_words: consolidation.consolidation_target_words,
        ...(consolidation.consolidation_plan ? { consolidation_plan: consolidation.consolidation_plan } : {}),
        consolidation_status: "feedback",
      } : {}),
      ...(state.payload.consolidation_deferred === true ? { consolidation_deferred: true } : {}),
      ...(state.payload.resume_state ? { resume_state: state.payload.resume_state } : {}),
      ...(Object.prototype.hasOwnProperty.call(state.payload, "lesson_profile") ? { lesson_profile: state.payload.lesson_profile } : {}),
      ...(Object.prototype.hasOwnProperty.call(state.payload, "error_focus") ? { error_focus: state.payload.error_focus } : {}),
      ...(plan.success ? { plan: plan.data } : {}),
      word: state.current_word!,
      ...(acceptedAnswers.length > 0 ? { accepted_answers: acceptedAnswers } : {}),
      progress: consolidation
        ? consolidation.consolidation_kind === "translation" ? "周期巩固 · 英译中" : "周期巩固 · 主动表达"
        : lessonProgressLabel(state.flow.relearn_words, queue, state.current_index),
      exercise: exercisePayload,
      feedback: {
        is_correct: grade.is_correct,
        user_answer: answer,
        error_layer: grade.error_layer,
        message: grade.message,
        explanation: grade.explanation,
        reveal_answer: reveal,
        ...(reveal && referenceAnswer ? { reference_answer: referenceAnswer } : {}),
        ...(grade.task_fulfillment !== undefined ? { task_fulfillment: grade.task_fulfillment } : {}),
        ...(grade.meaning ? { meaning: grade.meaning } : {}),
        ...(grade.collocation ? { collocation: grade.collocation } : {}),
        ...(grade.grammar ? { grammar: grade.grammar } : {}),
        ...(grade.naturalness ? { naturalness: grade.naturalness } : {}),
        ...(grade.target_word_results ? { target_word_results: grade.target_word_results } : {}),
        ...(grade.skill_results ? { skill_results: grade.skill_results } : {}),
        ...(grade.error_excerpt ? { error_excerpt: grade.error_excerpt } : {}),
        ...(grade.short_hint ? { short_hint: grade.short_hint } : {}),
      },
      navigation,
    },
  };
}

function lessonSkillEvidence(
  plan: z.infer<typeof lessonExercisePlanSchema>,
  grade: Awaited<ReturnType<typeof gradeLesson>>,
  firstAttempt: boolean,
  hintUsed: boolean,
  answerRevealed: boolean,
) {
  return plannedSkillEvidence({
    plan,
    skill_results: grade.skill_results,
    first_attempt: firstAttempt,
    hint_used: hintUsed,
    answer_revealed: answerRevealed,
    modified_correct: !firstAttempt && grade.is_correct,
    ...(grade.graded_by === "deterministic" ? { deterministic_outcome: grade.is_correct ? "correct" : "incorrect" } : {}),
  });
}
async function submitLesson(action: Extract<WebAction, { action: "lesson_submit" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (!active || state.phase !== "lesson_exercise") throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson is not accepting an answer.");
  assertLessonCursor(state);
  const exercise = lessonExercise(state);
  const plan = await savedOrLegacyPlan(state, exercise.activity_type, "lesson");
  const plannedState = state.payload.plan ? state : { ...state, payload: { ...state.payload, plan } };
  const grade = await gradeLesson(plannedState, exercise, action.answer);
  const nextState = lessonFeedbackState(plannedState, exercise, action.answer, grade);
  const feedback = nextState.payload.feedback as Record<string, unknown>;
  const answerRevealed = feedback.reveal_answer === true;
  const hintUsed = state.payload.hint_used === true;
  const saved = await recordPlannedSubmission({
    active,
    expected_revision: action.expected_revision,
    submission_id: action.submission_id ?? globalThis.crypto.randomUUID(),
    plan,
    scope: "lesson",
    word: state.current_word!,
    activity_type: exercise.activity_type,
    user_answer: action.answer,
    is_correct: grade.is_correct,
    error_layer: grade.error_layer,
    skill_evidence: lessonSkillEvidence(plan, grade, state.retry_count === 0, hintUsed, answerRevealed),
    first_attempt: state.retry_count === 0,
    hint_used: hintUsed,
    answer_revealed: answerRevealed,
    active_ms: null,
    grading_ms: null,
    next_state: nextState,
    completion_date: await getStudyDate(),
    cadence_candidates: cadenceCandidatePlans(plan, state.current_word!),
  });
  return successForSession(saved, {
    result: { is_correct: grade.is_correct, error_layer: grade.error_layer, message: grade.message },
  });
}

async function lessonNext(action: Extract<WebAction, { action: "lesson_next" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (!active) throw new WebApiError(409, "NO_ACTIVE_SESSION", "There is no active Lesson session.");
  if (state.phase === "lesson_complete" && state.payload.mode === "feedback" && state.payload.consolidation !== true) {
    const scheduled = await ensureLessonConsolidationScheduled(active);
    const consolidation = scheduled.state ? lessonConsolidation(scheduled.state) : null;
    if (consolidation?.consolidation_status === "pending") return successForSession(scheduled);
    if (consolidation) throw new WebApiError(409, "INVALID_STUDY_STATE", "The scheduled consolidation must be completed before continuing.");
    await finishStudySession(getDatabase(), getAuthenticatedUserId(), {
      revision: scheduled.updated_at,
      sessionId: scheduled.id,
      allowLessonRoundCompletion: true,
    });
    return resolveBootstrap(null);
  }
  if (state.phase !== "lesson_feedback") throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson has no completed exercise to advance.");
  if (action.expected_revision === null) throw new StaleStudyStateError();
  const feedback = typeof state.payload.feedback === "object" && state.payload.feedback !== null
    ? state.payload.feedback as Record<string, unknown>
    : {};
  if (feedback.is_correct !== true && feedback.reveal_answer !== true) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The current Lesson answer must be retried before advancing.");
  }
  const queue = assertLessonCursor(state);
  const navigation = lessonNavigationSchema.safeParse(state.payload.navigation);
  const serverNavigation = buildLessonNavigation(queue, state.current_index, state.current_word!);
  const nextAction = navigation.success ? navigation.data : serverNavigation;
  if (JSON.stringify(nextAction) !== JSON.stringify(serverNavigation)) {
    throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "Saved Lesson navigation does not match the frozen queue.");
  }
  if (nextAction.action === "next_word") {
    const expectedWord = lessonWordAt(queue, nextAction.next_index);
    if (!expectedWord || expectedWord !== nextAction.next_word) throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The next Lesson word does not match the frozen queue.");
    const result = await generateAndPersistLesson({
      word: expectedWord,
      date: state.date,
      flow: state.flow,
      index: nextAction.next_index,
      expectedRevision: action.expected_revision,
      sessionId: active.id,
    });
    return successForSession(result.session, {}, result.audioUrl);
  }
  const completed = await advanceStudySessionIfRevision("lesson_complete", state.current_index, action.expected_revision, active.id);
  const consolidation = completed.state ? lessonConsolidation(completed.state) : null;
  if (consolidation?.consolidation_status === "pending") return successForSession(completed);
  if (consolidation) throw new WebApiError(409, "INVALID_STUDY_STATE", "The scheduled consolidation must be completed before continuing.");
  await finishStudySession(getDatabase(), getAuthenticatedUserId(), {
    revision: completed.updated_at,
    sessionId: active.id,
    allowLessonRoundCompletion: true,
  });
  return resolveBootstrap(null);
}

async function ensureLessonConsolidationScheduled(active: StudySessionRow): Promise<StudySessionRow> {
  const state = activeState(active, "lesson");
  if (lessonConsolidation(state)) return active;
  const scheduled = await decideLessonConsolidation(state, getDatabase(), getAuthenticatedUserId());
  if (scheduled === state) return active;
  return persistStudyStateIfRevision(scheduled, active.updated_at, getDatabase(), getAuthenticatedUserId(), active.id);
}

function wordInText(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(text);
}

export async function generateAndReturnConsolidation(active: StudySessionRow): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  const consolidation = lessonConsolidation(state);
  if (state.phase !== "lesson_complete" || !state.current_word || !consolidation
    || consolidation.consolidation_status !== "pending") {
    throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "The scheduled consolidation is not ready to generate.");
  }
  const queue = assertLessonCursor(state);
  if (state.current_index !== queue.length - 1) throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "The Lesson round is not at its final word.");
  const words = consolidation.consolidation_target_words;
  const plan = consolidation.consolidation_plan;
  const exercise = plan
    ? await generatePlannedConsolidation({ plan, words })
    : consolidation.consolidation_kind === "translation"
      ? await generateWrapup({ words })
      : await generateSentenceConsolidation({ words });
  if (plan && exercise.activity_type !== plan.planned_activity_type) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "The consolidation exercise did not match its saved activity plan.");
  }
  const included = words.filter((word) => wordInText(exercise.prompt, word));
  const requiredWords = plan ? (plan.planned_activity_type === "sentence" ? words.length : 0)
    : consolidation.consolidation_kind === "translation" ? 2 : words.length;
  if (included.length < requiredWords) throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "The consolidation exercise did not use the planned target words.");
  const nextState: StudyState = {
    ...state,
    phase: "lesson_complete",
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "exercise",
      consolidation: true,
      consolidation_kind: consolidation.consolidation_kind,
      consolidation_trigger_round: consolidation.consolidation_trigger_round,
      consolidation_target_words: words,
      ...(plan ? { consolidation_plan: plan, plan } : {}),
      consolidation_status: "exercise",
      word: state.current_word,
      progress: plan?.planned_activity_type === "translation_cn_to_en" || consolidation.consolidation_kind === "translation_cn_to_en"
        ? "应用巩固 · 中译英"
        : plan?.planned_activity_type === "sentence" || consolidation.consolidation_kind === "sentence"
          ? "应用巩固 · 情境造句" : "应用巩固 · 长难句英译中",
      ...exercise,
      ...(consolidation.consolidation_kind === "translation" ? {
        instruction: "先找出句子主干，再把整句翻译成自然中文。",
      } : {}),
      navigation: buildLessonNavigation(queue, state.current_index, state.current_word),
    },
  };
  try {
    const saved = await persistStudyStateIfRevision(nextState, active.updated_at, getDatabase(), getAuthenticatedUserId(), active.id);
    return successForSession(saved);
  } catch (error) {
    if (!(error instanceof StaleStudyStateError)) throw error;
    const winner = await getActiveStudySession();
    const winnerMarker = winner?.state?.widget === "lesson" ? lessonConsolidation(winner.state) : null;
    if (winner?.id === active.id && winnerMarker
      && winnerMarker.consolidation_kind === consolidation.consolidation_kind
      && winnerMarker.consolidation_trigger_round === consolidation.consolidation_trigger_round
      && JSON.stringify(winnerMarker.consolidation_target_words) === JSON.stringify(words)
      && winnerMarker.consolidation_status !== "pending") {
      return successForSession(winner);
    }
    throw error;
  }
}

async function submitConsolidation(action: { answer: string; expected_revision: string | null; submission_id?: string }, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  const consolidation = lessonConsolidation(state);
  if (!active || state.phase !== "lesson_complete" || state.payload.mode !== "exercise"
    || consolidation?.consolidation_status !== "exercise") {
    throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "The saved consolidation exercise is unavailable.");
  }
  const exercise = lessonExercise(state);
  const existingPlan = lessonExercisePlanSchema.safeParse(consolidation.consolidation_plan ?? state.payload.plan);
  const expectedType = existingPlan.success ? existingPlan.data.planned_activity_type
    : consolidation.consolidation_kind === "translation" ? "translation_en_to_cn"
      : consolidation.consolidation_kind === "translation_cn_to_en" ? "translation_cn_to_en" : "sentence";
  const plan = await savedOrLegacyPlan(state, expectedType, "consolidation");
  const plannedState: StudyState = {
    ...state,
    payload: { ...state.payload, plan, consolidation_plan: plan },
  };
  if (exercise.activity_type !== expectedType || !exercise.multiline) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved consolidation exercise is invalid.");
  }
  const grade: WrapupGrade | SemanticGrade = !existingPlan.success && consolidation.consolidation_kind === "translation"
    ? await gradeWrapupAnswer({
      words: consolidation.consolidation_target_words,
      instruction: exercise.instruction,
      prompt: exercise.prompt,
      answer: action.answer,
      retry_count: state.retry_count,
    })
    : await requestSemanticGrade({
      word: state.current_word!,
      target_words: consolidation.consolidation_target_words,
      activity_type: expectedType,
      instruction: exercise.instruction,
      prompt: exercise.prompt,
      answer: action.answer,
      retry_count: state.retry_count,
      plan,
    });
  if (!grade.is_correct && grade.error_layer === "none") {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "DeepSeek output did not satisfy the grading rules.");
  }
  if (!grade.is_correct && state.retry_count >= 1 && !grade.reference_answer?.trim()) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "A second incorrect consolidation grade must include a reference expression.");
  }
  const canonicalGrade = buildSemanticGrade({
    isCorrect: grade.is_correct,
    errorLayer: grade.error_layer,
    feedback: grade.message,
    advancesFsrs: false,
  });
  assertGradeInvariants(canonicalGrade, { activity_type: expectedType, advancesFsrs: false });
  const feedbackState = lessonFeedbackState(plannedState, exercise, action.answer, {
    ...canonicalGrade,
    message: grade.message,
    explanation: grade.explanation,
    ...(grade.reference_answer ? { reference_answer: grade.reference_answer } : {}),
  });
  const feedback = feedbackState.payload.feedback as Record<string, unknown>;
  const answerRevealed = feedback.reveal_answer === true;
  const saved = await recordPlannedSubmission({
    active,
    expected_revision: action.expected_revision,
    submission_id: action.submission_id ?? globalThis.crypto.randomUUID(),
    plan,
    scope: "consolidation",
    word: state.current_word!,
    activity_type: expectedType,
    user_answer: action.answer,
    is_correct: grade.is_correct,
    error_layer: canonicalGrade.error_layer,
    skill_evidence: lessonSkillEvidence(plan, {
      ...canonicalGrade,
      message: grade.message,
      explanation: grade.explanation,
      ...(grade.skill_results ? { skill_results: grade.skill_results } : {}),
      graded_by: "semantic",
      ...(grade.target_word_results ? { target_word_results: grade.target_word_results } : {}),
      ...(grade.task_fulfillment !== undefined ? { task_fulfillment: grade.task_fulfillment } : {}),
      ...(grade.meaning ? { meaning: grade.meaning } : {}),
      ...(grade.collocation ? { collocation: grade.collocation } : {}),
      ...(grade.grammar ? { grammar: grade.grammar } : {}),
      ...(grade.naturalness ? { naturalness: grade.naturalness } : {}),
      ...(grade.error_excerpt ? { error_excerpt: grade.error_excerpt } : {}),
      ...(grade.short_hint ? { short_hint: grade.short_hint } : {}),
      ...(grade.reference_answer ? { reference_answer: grade.reference_answer } : {}),
    }, state.retry_count === 0, state.payload.hint_used === true, answerRevealed),
    first_attempt: state.retry_count === 0,
    hint_used: state.payload.hint_used === true,
    answer_revealed: answerRevealed,
    active_ms: null,
    grading_ms: null,
    next_state: feedbackState,
    completion_date: await getStudyDate(),
  });
  return successForSession(saved);
}

async function retryConsolidation(action: { expected_revision: string | null }, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  const consolidation = lessonConsolidation(state);
  const feedback = typeof state.payload.feedback === "object" && state.payload.feedback !== null
    ? state.payload.feedback as Record<string, unknown>
    : null;
  if (!active || state.phase !== "lesson_complete" || state.payload.mode !== "feedback"
    || consolidation?.consolidation_status !== "feedback"
    || feedback?.is_correct !== false || feedback.reveal_answer !== false) {
    throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "The consolidation is not eligible for a retry.");
  }
  const exercise = lessonExercise(state);
  const queue = assertLessonCursor(state);
  const nextState: StudyState = {
    ...state,
    phase: "lesson_complete",
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "exercise",
      consolidation: true,
      consolidation_kind: consolidation.consolidation_kind,
      consolidation_trigger_round: consolidation.consolidation_trigger_round,
      consolidation_target_words: consolidation.consolidation_target_words,
      consolidation_status: "exercise",
      word: state.current_word!,
      progress: consolidation.consolidation_kind === "translation" ? "周期巩固 · 英译中" : "周期巩固 · 主动表达",
      ...exercise,
      navigation: buildLessonNavigation(queue, state.current_index, state.current_word!),
    },
  };
  const saved = await persistStudyStateIfRevision(nextState, action.expected_revision, getDatabase(), getAuthenticatedUserId(), active.id);
  return successForSession(saved);
}

async function finishConsolidation(action: { expected_revision: string | null }, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  const consolidation = lessonConsolidation(state);
  if (!active || !consolidation || consolidation.consolidation_status !== "feedback" || !isCompletedLessonRound(state)) {
    throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_COMPLETE", "The consolidation must be correct or fully revealed before finishing.");
  }
  await finishStudySession(getDatabase(), getAuthenticatedUserId(), {
    revision: action.expected_revision ?? "",
    sessionId: active.id,
    allowLessonRoundCompletion: true,
  });
  return resolveBootstrap(null);
}

async function startPendingConsolidation(action: { expected_revision: string | null }, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  if (active?.state) {
    const state = normalizeStudyStateForRead(active.state);
    const pending = state.widget === "lesson" ? lessonConsolidation(state) : null;
    if (!pending || pending.consolidation_status !== "pending" || state.phase !== "lesson_complete") {
      throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "There is no pending application task to start.");
    }
    return generateAndReturnConsolidation(active);
  }

  const cadence = await getLessonCadence();
  const pending = cadence.pending_task;
  if (!pending) throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "There is no pending application task to start.");
  const word = pending.target_words[0];
  if (!word || pending.plan.scope !== "consolidation") throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "The saved application task is invalid.");
  const date = await getStudyDate();
  const kind: ConsolidationKind = pending.plan.planned_activity_type === "translation_cn_to_en" ? "translation_cn_to_en"
    : pending.plan.planned_activity_type === "sentence" ? "sentence" : "translation";
  const initialState = makeStudyState({
    date,
    widget: "lesson",
    phase: "lesson_complete",
    current_word: word,
    current_index: 0,
    retry_count: 0,
    flow: { relearn_words: [], lesson_words: [word] },
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "pending",
      consolidation: true,
      consolidation_kind: kind,
      consolidation_trigger_round: 10,
      consolidation_target_words: pending.target_words,
      consolidation_plan: pending.plan,
      plan: pending.plan,
      consolidation_status: "pending",
      word,
      progress: "应用巩固 · 待做",
    },
  });
  const session = await persistStudyStateIfRevision(initialState, action.expected_revision);
  return generateAndReturnConsolidation(session);
}

async function deferPendingConsolidation(action: { expected_revision: string | null }, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  const consolidation = lessonConsolidation(state);
  if (!active || state.phase !== "lesson_complete" || consolidation?.consolidation_status !== "pending"
    || state.payload.mode !== "feedback") {
    throw new WebApiError(409, "LESSON_CONSOLIDATION_NOT_READY", "Only the round-end application choice can be deferred here.");
  }
  const deferred: StudyState = {
    ...state,
    payload: { ...state.payload, consolidation_deferred: true },
  };
  const saved = await persistStudyStateIfRevision(deferred, action.expected_revision, getDatabase(), getAuthenticatedUserId(), active.id);
  await finishStudySession(getDatabase(), getAuthenticatedUserId(), {
    revision: saved.updated_at,
    sessionId: saved.id,
    allowLessonRoundCompletion: true,
  });
  return doneResponse(null);
}

async function setDailyNewWordLimitAction(
  action: Extract<WebAction, { action: "set_daily_new_word_limit" }>,
): Promise<Record<string, unknown>> {
  const current = await getActiveStudySession();
  if (current && action.expected_revision !== null && current.updated_at !== action.expected_revision) {
    throw new StaleStudyStateError();
  }

  const saved = await setDailyNewWordLimit(action.limit);
  const active = await getActiveStudySession();
  const response = active ? await successForSession(active) : await doneResponse(null);
  return {
    ...response,
    progress: await getProgress(),
    settings_update: {
      daily_new_word_limit: saved.daily_new_word_limit,
      prepared: saved.prepared,
      added: saved.added,
    },
  };
}

async function performAction(action: WebAction): Promise<Record<string, unknown>> {
  if (action.action === "set_daily_new_word_limit") return setDailyNewWordLimitAction(action);
  if (action.action === "refresh_progress") return { screen: "done", session_revision: action.expected_revision, state: {}, progress: await getProgress() };
  if (action.action === "continue") return resolveBootstrap(action.expected_revision);
  if (action.action === "pretest_mark_familiar") return markPretestFamiliarFromWeb(action);
  if (action.action === "pretest_continue") return continuePretest(action);
  const active = await assertActiveStudySessionRevision(action.expected_revision);
  switch (action.action) {
    case "review_submit": return submitReview(action, active);
    case "pretest_submit": return submitPretest(action, active);
    case "lesson_start_exercise": {
      const state = activeState(active, "lesson");
      if (!active || state.phase !== "lesson_explain") throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson is not ready for an exercise.");
      const saved = await advanceStudySessionIfRevision("lesson_start_exercise", state.current_index, action.expected_revision ?? "", active.id);
      return successForSession(saved);
    }
    case "lesson_submit": return submitLesson(action, active);
    case "lesson_retry": {
      const state = activeState(active, "lesson");
      if (!active || state.phase !== "lesson_feedback") throw new WebApiError(409, "INVALID_STUDY_STATE", "There is no Lesson feedback to retry.");
      const saved = await advanceStudySessionIfRevision("lesson_retry", state.current_index, action.expected_revision ?? "", active.id);
      return successForSession(saved);
    }
    case "lesson_next": return lessonNext(action, active);
    case "consolidation_start": return startPendingConsolidation(action, active);
    case "consolidation_defer": return deferPendingConsolidation(action, active);
    case "consolidation_submit":
    case "wrapup_submit": return submitConsolidation(action, active);
    case "consolidation_retry":
    case "wrapup_retry": return retryConsolidation(action, active);
    case "consolidation_finish":
    case "wrapup_finish": return finishConsolidation(action, active);
    default: throw new WebApiError(400, "INVALID_REQUEST", "The requested study action is invalid.");
  }
}

export async function handleWebApiRequest(request: Request): Promise<Response> {
  try {
    authenticate(request);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/web/bootstrap") {
      return jsonApiResponse(await resolveBootstrap());
    }
    if (request.method === "GET" && url.pathname === "/api/web/today") {
      return jsonApiResponse(await getTodayOverview());
    }
    if (request.method === "GET" && url.pathname === "/api/web/analytics") {
      const parsed = analyticsQuerySchema.safeParse({
        section: url.searchParams.get("section"),
        range: url.searchParams.get("range") ?? "30d",
        cursor: url.searchParams.get("cursor") ?? "",
        limit: url.searchParams.get("limit") ?? 50,
      });
      if (!parsed.success) throw new WebApiError(400, "INVALID_REQUEST", "洞察查询仅支持 overview、memory、weakness、activity 与 7d、30d、90d。");
      return jsonApiResponse(await getAnalytics(parsed.data.section, parsed.data.range, parsed.data.cursor, parsed.data.limit));
    }
    if (request.method === "GET" && url.pathname === "/api/web/vocabulary") {
      const parsed = vocabularyQuerySchema.safeParse({
        q: url.searchParams.get("q") ?? "",
        filters: url.searchParams.getAll("filter"),
        cursor: url.searchParams.get("cursor") ?? "",
        limit: url.searchParams.get("limit") ?? 50,
      });
      if (!parsed.success) throw new WebApiError(400, "INVALID_REQUEST", "词库搜索与筛选条件无效。");
      return jsonApiResponse(await listVocabulary(parsed.data));
    }
    const vocabularyMatch = /^\/api\/web\/vocabulary\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (request.method === "GET" && vocabularyMatch) {
      return jsonApiResponse(await getVocabularyDetail(vocabularyMatch[1]!));
    }
    if (request.method === "GET" && url.pathname === "/api/web/captures") {
      const requestedStatus = url.searchParams.get("status");
      const status = requestedStatus === "converted" ? "learning"
        : requestedStatus === "dismissed" ? "archived"
          : requestedStatus === "all" ? undefined
            : requestedStatus ?? undefined;
      const parsed = captureListRequestSchema.safeParse({
        status,
        q: url.searchParams.get("q") ?? "",
        cursor: url.searchParams.get("cursor") ?? "",
        limit: url.searchParams.get("limit") ?? 50,
      });
      if (!parsed.success) throw new WebApiError(400, "INVALID_REQUEST", "划词笔记查询条件无效。");
      const result = await listCaptureNotes(parsed.data);
      const legacyStatus = requestedStatus === "converted" || requestedStatus === "dismissed" || requestedStatus === "all";
      return jsonApiResponse(legacyStatus
        ? { ...result, items: result.items.map(legacyCaptureResponse) }
        : result);
    }
    if (request.method === "POST" && url.pathname === "/api/web/captures") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new WebApiError(400, "INVALID_REQUEST", "Request body must be valid JSON.");
      }
      const parsed = captureCreateRequestSchema.safeParse(body);
      if (!parsed.success) throw new WebApiError(400, "INVALID_REQUEST", "The capture payload is invalid.");
      const item = await createCaptureNote(parsed.data);
      return jsonApiResponse({
        item,
        note_id: item.id,
        occurrence_count: item.occurrence_count,
        new_occurrence: item.new_occurrence,
      }, 201);
    }
    const occurrenceMatch = /^\/api\/web\/captures\/([0-9a-f-]{36})\/occurrences$/i.exec(url.pathname);
    if (request.method === "GET" && occurrenceMatch) {
      const parsed = z.object({
        cursor: z.string().max(100).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }).strict().safeParse({
        cursor: url.searchParams.get("cursor") ?? "",
        limit: url.searchParams.get("limit") ?? 50,
      });
      if (!parsed.success) throw new WebApiError(400, "INVALID_REQUEST", "出现记录分页条件无效。");
      return jsonApiResponse(await listCaptureNoteOccurrences(occurrenceMatch[1]!, parsed.data));
    }
    const captureMatch = /^\/api\/web\/captures\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (request.method === "GET" && captureMatch) {
      return jsonApiResponse({ item: await getCaptureNoteById(captureMatch[1]!) });
    }
    if (request.method === "PATCH" && captureMatch) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new WebApiError(400, "INVALID_REQUEST", "Request body must be valid JSON.");
      }
      const parsed = captureUpdateRequestSchema.safeParse(body);
      if (!parsed.success) throw new WebApiError(400, "INVALID_REQUEST", "The capture update is invalid.");
      const item = await updateCaptureNote(captureMatch[1]!, parsed.data);
      return jsonApiResponse({ id: item.id, item });
    }
    const learnMatch = /^\/api\/web\/captures\/([0-9a-f-]{36})\/learn$/i.exec(url.pathname);
    const promoteMatch = /^\/api\/web\/captures\/([0-9a-f-]{36})\/promote$/i.exec(url.pathname);
    if (request.method === "POST" && (learnMatch || promoteMatch)) {
      const captureId = (learnMatch ?? promoteMatch)![1]!;
      const result = await addCaptureNoteToLearning(captureId);
      if (promoteMatch) {
        return jsonApiResponse({
          item: result.note,
          note_id: result.note.id,
          normalized_word: result.note.normalized_text,
          is_new: result.scheduled_today,
        });
      }
      return jsonApiResponse({
        item: result.note,
        learning_update: {
          scheduled_today: result.scheduled_today,
          existing_status: result.existing_status,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/web/action") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new WebApiError(400, "INVALID_REQUEST", "Request body must be valid JSON.");
      }
      const action = webActionSchema.safeParse(body);
      if (!action.success) throw new WebApiError(400, "INVALID_REQUEST", "The requested study action is invalid.");
      return jsonApiResponse(await performAction(action.data));
    }
    if (url.pathname.startsWith("/api/web/")) {
      return jsonApiResponse({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    }
    return jsonApiResponse({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  } catch (error) {
    return failure(error);
  }
}
