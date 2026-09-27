import { z } from "zod";
import { getAuthenticatedUserId, getDatabase, getWordloopWebToken } from "./db.js";
import { getStudyBootstrap } from "./services/studyBootstrap.js";
import { getProgress } from "./services/progress.js";
import {
  advanceStudySessionIfRevision,
  assertActiveStudySessionRevision,
  finishStudySession,
  getActiveStudySession,
  getPretestResults,
  getStudyDate,
  isCompletedLessonWrapup,
  makeStudyState,
  normalizeLegacyLessonSession,
  normalizeStudyStateForRead,
  persistStudyStateIfRevision,
  StaleStudyStateError,
} from "./services/studySessions.js";
import {
  buildLessonNavigation,
  buildLessonWords,
  isLessonCursorAtCurrentWord,
  lessonWordAt,
  lessonWordIndex,
} from "./services/lessonQueue.js";
import { getTodayWords, getVocabularyItemsByWords, recordPretestResult } from "./services/words.js";
import { buildReviewWidgetPayload } from "./tools/renderWidgets.js";
import { getPronunciationAudio } from "./tools/getPronunciationAudio.js";
import { getTodayCompletedLessonWords, recordAttempt } from "./services/attempts.js";
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
  recordReviewSubmissionSchema,
  reviewWidgetItemSchema,
  type ReviewWidgetItem,
} from "../shared/toolContracts.js";
import type { StudySessionRow, StudyState, VocabularyItem } from "./types.js";
import {
  DeepSeekError,
  generateLesson,
  generateWrapup,
  gradeEnglishDefinition,
  gradeSemanticAnswer as requestSemanticGrade,
  gradeWrapupAnswer,
  type LessonGeneration,
  type SemanticGrade,
  type WrapupGrade,
} from "./services/deepseek.js";
import { normalizeWord } from "./services/wordNormalization.js";

const expectedRevisionSchema = z.string().trim().min(1).nullable();
const mutationBase = { expected_revision: expectedRevisionSchema };
const webActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), ...mutationBase }).strict(),
  z.object({ action: z.literal("review_submit"), answer: z.string().max(4000), mark_unknown: z.boolean().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("pretest_submit"), answer: z.string().max(2000), mark_unknown: z.boolean().optional(), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_start_exercise"), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_submit"), answer: z.string().trim().min(1).max(4000), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_retry"), ...mutationBase }).strict(),
  z.object({ action: z.literal("lesson_next"), ...mutationBase }).strict(),
  z.object({ action: z.literal("wrapup_submit"), answer: z.string().trim().min(1).max(4000), ...mutationBase }).strict(),
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
  if (error instanceof DeepSeekError) return new WebApiError(error.status, error.code, error.message);
  if (error instanceof StaleStudyStateError || (error instanceof Error && error.message === "STALE_STUDY_STATE")) {
    return new WebApiError(409, "STALE_STUDY_STATE", "Study state changed in another client.");
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "NO_ACTIVE_SESSION" || /No resumable active study session|No active study session/.test(message)) {
    return new WebApiError(409, "NO_ACTIVE_SESSION", "There is no active study session.");
  }
  if (["LESSON_QUEUE_MISSING", "LESSON_CURSOR_MISMATCH", "LESSON_WRAPUP_NOT_READY", "LESSON_WRAPUP_NOT_COMPLETE", "INVALID_STUDY_STATE"].includes(message)) {
    return new WebApiError(409, message, "The current study state cannot perform this action.");
  }
  if (message === "LESSON_WORD_NOT_FOUND" || message === "LESSON_WORD_MISMATCH") {
    return new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The Lesson queue no longer matches the active word.");
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
  return (item.senses ?? []).map((sense) => sense.definition_cn.trim()).filter(Boolean).join("；");
}

function persistedPartOfSpeech(item: VocabularyItem): string | undefined {
  return item.senses?.find((sense) => sense.pos.trim())?.pos.trim();
}

function pretestItems(words: VocabularyItem[]): Array<Record<string, unknown>> {
  if (words.length === 0) throw new WebApiError(409, "INVALID_STUDY_STATE", "The pretest queue is empty.");
  return words.map((item) => {
    const meaning = persistedMeaning(item);
    if (!meaning) throw new WebApiError(409, "INVALID_STUDY_STATE", "A pretest word has no saved Chinese meaning.");
    return {
      word: item.word,
      ipa: item.ipa_us?.trim() || "—",
      part_of_speech: persistedPartOfSpeech(item) ?? "词性未标注",
      meaning_zh: meaning.slice(0, 240),
      prompt: meaning.slice(0, 240),
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
    if (typeof payload.exercise === "object" && payload.exercise !== null && !Array.isArray(payload.exercise)) {
      const exercise = { ...payload.exercise as Record<string, unknown> };
      delete exercise.accepted_answers;
      payload.exercise = exercise;
    }
    responseState = { ...state, payload };
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
  if (state.widget === "lesson") response.pronunciation_audio_url = audioUrl === undefined ? await pronunciationUrl(state.current_word) : audioUrl;
  if (state.widget === "pretest" && state.phase === "pretest_complete") {
    const results = await getPretestResults(session);
    const counts = { known: 0, uncertain: 0, unknown: 0 };
    for (const result of results) {
      if (result.status === "known" || result.status === "uncertain" || result.status === "unknown") counts[result.status] += 1;
    }
    response.pretest_results = results;
    response.pretest_summary = counts;
  }
  const progress = await progressIfAvailable();
  if (progress !== undefined) response.progress = progress;
  return response;
}

async function doneResponse(revision: string | null = null): Promise<Record<string, unknown>> {
  return {
    screen: "done",
    session_revision: revision,
    state: {},
    progress: await getProgress(),
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
  const items = pretestItems(words);
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
  const pos = persistedPartOfSpeech(item) ?? "未标注词性";
  const [generated, audioUrl] = await Promise.all([
    generateLesson({
      word: item.word,
      meaning_zh: meaning,
      part_of_speech: pos,
      ...(item.ipa_us?.trim() ? { ipa: item.ipa_us.trim() } : {}),
    }),
    pronunciationUrl(item.word),
  ]);
  const queue = input.flow.lesson_words;
  if (!queue || queue.length === 0 || !isLessonCursorAtCurrentWord(queue, item.word, input.index)) {
    throw new WebApiError(409, "LESSON_CURSOR_MISMATCH", "The Lesson queue no longer matches the active word.");
  }
  const navigation = buildLessonNavigation(queue, input.index, item.word);
  await assertActiveStudySessionRevision(input.expectedRevision, input.sessionId, db, userId);
  const state = makeStudyState({
    date: input.date,
    widget: "lesson",
    phase: "lesson_explain",
    current_word: item.word,
    current_index: input.index,
    retry_count: 0,
    flow: input.flow,
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "explain",
      word: item.word,
      progress: lessonProgressLabel(input.flow.relearn_words, queue, input.index),
      ipa: generated.ipa,
      part_of_speech: generated.part_of_speech,
      meaning_zh: generated.meaning_zh,
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
  const session = await persistStudyStateIfRevision(state, input.expectedRevision, db, userId, input.sessionId);
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
    let lessonWords = state.flow.lesson_words ?? bootstrap.lesson_words;
    if (!lessonWords) {
      const [todayWords, completedTodayLessonWords] = await Promise.all([
        getTodayWords(state.date, db, userId),
        getTodayCompletedLessonWords(db, userId),
      ]);
      lessonWords = buildLessonWords(state.flow.relearn_words, todayWords, completedTodayLessonWords);
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
  const [todayWords, completedTodayLessonWords] = await Promise.all([
    getTodayWords(date, db, userId),
    getTodayCompletedLessonWords(db, userId),
  ]);
  const lessonWords = buildLessonWords([], todayWords, completedTodayLessonWords);
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
  const itemCount = items.data.length;
  const next = state.current_index + 1;
  const completed = next >= itemCount
    ? await advanceStudySessionIfRevision("pretest_complete", itemCount, nextResult.updated_at, active.id)
    : await advanceStudySessionIfRevision("pretest_question", next, nextResult.updated_at, active.id);
  return successForSession(completed, { result: { status: result } });
}

const lessonExerciseSchema = z.object({
  activity_type: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(300),
  prompt: z.string().trim().min(1).max(4000),
  multiline: z.boolean(),
});

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
  return parsed.data;
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
}> {
  const deterministic = deterministicLessonGrade(state, exercise, answer);
  if (deterministic) return deterministic;
  if (![
    "translation_cn_to_en", "translation_en_to_cn", "collocation", "sentence", "semantic_expression", "pretest_en_definition",
  ].includes(exercise.activity_type)) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved Lesson exercise does not have a supported grading route.");
  }
  if (!state.current_word) throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson word is unavailable.");
  const semantic: SemanticGrade = await requestSemanticGrade({
    word: state.current_word,
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
  };
}

function lessonFeedbackState(
  state: StudyState,
  exercise: z.infer<typeof lessonExerciseSchema>,
  answer: string,
  grade: Awaited<ReturnType<typeof gradeLesson>>,
  wrapup: boolean,
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
  return {
    ...state,
    phase: wrapup ? "lesson_complete" : "lesson_feedback",
    retry_count: nextRetry,
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "feedback",
      ...(wrapup ? { wrapup: true } : {}),
      word: state.current_word!,
      ...(acceptedAnswers.length > 0 ? { accepted_answers: acceptedAnswers } : {}),
      progress: wrapup ? "本轮长难句收尾" : lessonProgressLabel(state.flow.relearn_words, queue, state.current_index),
      exercise: exercisePayload,
      feedback: {
        is_correct: grade.is_correct,
        user_answer: answer,
        error_layer: grade.error_layer,
        message: grade.message,
        explanation: grade.explanation,
        reveal_answer: reveal,
        ...(reveal && referenceAnswer ? { reference_answer: referenceAnswer } : {}),
      },
      navigation,
    },
  };
}

function lessonProgressLabel(relearnWords: readonly string[], queue: readonly string[], index: number): string {
  const relearn = new Set(relearnWords.map(normalizeWord));
  const reviewCount = queue.filter((word) => relearn.has(normalizeWord(word))).length;
  if (index < reviewCount) return `复习补学 ${index + 1} / ${reviewCount}`;
  const newCount = queue.length - reviewCount;
  return `新词学习 ${Math.min(index - reviewCount + 1, newCount)} / ${newCount}`;
}

async function submitLesson(action: Extract<WebAction, { action: "lesson_submit" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (!active || state.phase !== "lesson_exercise") throw new WebApiError(409, "INVALID_STUDY_STATE", "The Lesson is not accepting an answer.");
  assertLessonCursor(state);
  const exercise = lessonExercise(state);
  const grade = await gradeLesson(state, exercise, action.answer);
  await assertActiveStudySessionRevision(action.expected_revision, active.id);
  const nextState = lessonFeedbackState(state, exercise, action.answer, grade, false);
  await recordAttempt({
    word: state.current_word!,
    session_id: active.id,
    activity_type: exercise.activity_type as never,
    user_answer: action.answer,
    is_correct: grade.is_correct,
    error_layer: grade.error_layer,
  });
  const saved = await persistStudyStateIfRevision(nextState, action.expected_revision, getDatabase(), getAuthenticatedUserId(), active.id);
  return successForSession(saved, {
    result: { is_correct: grade.is_correct, error_layer: grade.error_layer, message: grade.message },
  });
}

async function lessonNext(action: Extract<WebAction, { action: "lesson_next" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (!active) throw new WebApiError(409, "NO_ACTIVE_SESSION", "There is no active Lesson session.");
  if (state.phase === "lesson_complete" && state.payload.mode === "feedback" && state.payload.wrapup !== true) {
    return generateAndReturnWrapup(active);
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
  return generateAndReturnWrapup(completed);
}

async function generateAndReturnWrapup(active: StudySessionRow): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (state.phase !== "lesson_complete" || !state.current_word) {
    throw new WebApiError(409, "LESSON_WRAPUP_NOT_READY", "The Lesson round is not ready for its wrap-up.");
  }
  const queue = assertLessonCursor(state);
  if (state.current_index !== queue.length - 1) throw new WebApiError(409, "LESSON_WRAPUP_NOT_READY", "The Lesson round is not at its final word.");
  const words = queue.slice(-3);
  const exercise = await generateWrapup({ words });
  const included = words.filter((word) => new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(exercise.prompt));
  if (included.length < Math.min(2, words.length)) {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "DeepSeek output did not use enough words from the Lesson round.");
  }
  await assertActiveStudySessionRevision(active.updated_at, active.id);
  const navigation = buildLessonNavigation(queue, state.current_index, state.current_word);
  const nextState: StudyState = {
    ...state,
    phase: "lesson_complete",
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "exercise",
      wrapup: true,
      word: state.current_word,
      progress: "本轮长难句收尾",
      ...exercise,
      navigation,
    },
  };
  const saved = await persistStudyStateIfRevision(nextState, active.updated_at, getDatabase(), getAuthenticatedUserId(), active.id);
  return successForSession(saved);
}

async function submitWrapup(action: Extract<WebAction, { action: "wrapup_submit" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (!active || state.phase !== "lesson_complete" || state.payload.mode !== "exercise" || state.payload.wrapup !== true) {
    throw new WebApiError(409, "LESSON_WRAPUP_NOT_READY", "The saved wrap-up exercise is unavailable.");
  }
  const exercise = lessonExercise(state);
  if (exercise.activity_type !== "sentence" || !exercise.multiline) {
    throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved wrap-up exercise is invalid.");
  }
  const queue = assertLessonCursor(state);
  const grade: WrapupGrade = await gradeWrapupAnswer({
    words: queue.slice(-3),
    instruction: exercise.instruction,
    prompt: exercise.prompt,
    answer: action.answer,
    retry_count: state.retry_count,
  });
  if (!grade.is_correct && grade.error_layer === "none") {
    throw new DeepSeekError("DEEPSEEK_INVALID_OUTPUT", 502, "DeepSeek output did not satisfy the grading rules.");
  }
  const canonicalGrade = buildSemanticGrade({
    isCorrect: grade.is_correct,
    errorLayer: grade.error_layer,
    feedback: grade.message,
    advancesFsrs: false,
  });
  assertGradeInvariants(canonicalGrade, { activity_type: "sentence", advancesFsrs: false });
  await assertActiveStudySessionRevision(action.expected_revision, active.id);
  const feedbackState = lessonFeedbackState(state, exercise, action.answer, {
    ...canonicalGrade,
    message: grade.message,
    explanation: grade.explanation,
    ...(grade.reference_answer ? { reference_answer: grade.reference_answer } : {}),
  }, true);
  await recordAttempt({
    word: state.current_word!,
    session_id: active.id,
    activity_type: "sentence",
    user_answer: action.answer,
    is_correct: grade.is_correct,
    error_layer: canonicalGrade.error_layer,
  });
  const saved = await persistStudyStateIfRevision(feedbackState, action.expected_revision, getDatabase(), getAuthenticatedUserId(), active.id);
  return successForSession(saved);
}

async function retryWrapup(action: Extract<WebAction, { action: "wrapup_retry" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  const feedback = typeof state.payload.feedback === "object" && state.payload.feedback !== null
    ? state.payload.feedback as Record<string, unknown>
    : null;
  if (!active || state.phase !== "lesson_complete" || state.payload.mode !== "feedback" || state.payload.wrapup !== true
    || feedback?.is_correct !== false || feedback.reveal_answer !== false) {
    throw new WebApiError(409, "LESSON_WRAPUP_NOT_READY", "The wrap-up is not eligible for a retry.");
  }
  const exercise = lessonExercise(state);
  if (exercise.activity_type !== "sentence") throw new WebApiError(409, "INVALID_STUDY_STATE", "The saved wrap-up exercise is invalid.");
  const queue = assertLessonCursor(state);
  const nextState: StudyState = {
    ...state,
    phase: "lesson_complete",
    payload: {
      widget: "lesson",
      widget_version: 3,
      mode: "exercise",
      wrapup: true,
      word: state.current_word!,
      progress: "本轮长难句收尾",
      ...exercise,
      navigation: buildLessonNavigation(queue, state.current_index, state.current_word!),
    },
  };
  const saved = await persistStudyStateIfRevision(nextState, action.expected_revision, getDatabase(), getAuthenticatedUserId(), active.id);
  return successForSession(saved);
}

async function finishWrapup(action: Extract<WebAction, { action: "wrapup_finish" }>, active: StudySessionRow | null): Promise<Record<string, unknown>> {
  const state = activeState(active, "lesson");
  if (!active || !isCompletedLessonWrapup(state)) {
    throw new WebApiError(409, "LESSON_WRAPUP_NOT_COMPLETE", "The wrap-up must be correct or fully revealed before finishing.");
  }
  await finishStudySession(getDatabase(), getAuthenticatedUserId(), { revision: action.expected_revision ?? "", sessionId: active.id });
  return resolveBootstrap(null);
}

async function performAction(action: WebAction): Promise<Record<string, unknown>> {
  if (action.action === "refresh_progress") return { screen: "done", session_revision: action.expected_revision, state: {}, progress: await getProgress() };
  if (action.action === "continue") return resolveBootstrap(action.expected_revision);
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
    case "wrapup_submit": return submitWrapup(action, active);
    case "wrapup_retry": return retryWrapup(action, active);
    case "wrapup_finish": return finishWrapup(action, active);
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
