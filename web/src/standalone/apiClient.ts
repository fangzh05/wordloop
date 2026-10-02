const TOKEN_KEY = "wordloop_web_token";
export const WEB_REQUEST_TIMEOUT_MS = 75_000;
const readModelCache = new Map<string, { stored_at: number; value: unknown }>();

export function clearReadModelCache(): void {
  readModelCache.clear();
}

export class UnauthorizedError extends Error {
  constructor() {
    super("UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class StaleStudyStateError extends Error {
  constructor() {
    super("STALE_STUDY_STATE");
    this.name = "StaleStudyStateError";
  }
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface WebApiResponse {
  budget_paused?: boolean;
  screen: "review" | "pretest" | "lesson" | "done";
  session_revision: string | null;
  state: Record<string, unknown>;
  progress?: {
    today: { total: number; known: number; uncertain: number; unknown: number; completed: number };
    review_today: { completed: number; total: number; remaining: number };
    all_time: { total_words: number; mastered: number; learning: number; error_book: number };
    fsrs: { due_now: number; due_today: number; tomorrow: number; due_next_7_days: number; average_stability: number };
    settings: { daily_new_word_limit: number };
  };
  settings_update?: { daily_new_word_limit: number; prepared: number; added: number };
  pending_consolidation?: { activity_type: string; label: string; estimated_seconds: number } | null;
  pronunciation_audio_url?: string | null;
  result?: { status?: string; user_answer?: string; is_correct?: boolean; error_layer?: string; mark_familiar?: boolean; message?: string };
  pretest_summary?: { known: number; uncertain: number; unknown: number };
  pretest_result?: { word: string; status: string; user_answer?: string; is_correct?: boolean; error_layer?: string };
  pretest_results?: Array<{ word: string; status: string; user_answer?: string; is_correct?: boolean; error_layer?: string }>;
  message?: string;
  error?: { code: string; message: string };
}

export type CaptureSelectionType = "word" | "phrase" | "collocation" | "sentence" | "grammar";
export type LegacyCaptureStatus = "inbox" | "saved" | "dismissed" | "converted";
export type CaptureStatus = "inbox" | "saved" | "learning" | "archived";
export type CaptureSourceType = "lesson_example" | "lesson_prompt" | "review_question" | "manual" | "lesson" | "review" | "pretest" | "dashboard";
export type NoteReviewRating = "again" | "good";

export interface CapturedNoteOccurrence {
  context_text: string;
  source_type: CaptureSourceType;
  source_title: string | null;
  source_url: string | null;
  captured_at: string;
}

export interface CapturedNote {
  id: string;
  selected_text: string;
  normalized_text: string;
  selection_type: CaptureSelectionType;
  note: string;
  status: LegacyCaptureStatus;
  converted_user_word_id: string | null;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
  occurrences: CapturedNoteOccurrence[];
}

export interface CapturedNotePage {
  items: CapturedNote[];
  next_cursor: string | null;
}

export interface CaptureCreateInput {
  selected_text: string;
  selection_type: CaptureSelectionType;
  note?: string;
  context_text?: string;
  source_type?: CaptureSourceType;
  source_ref?: string;
  source_title?: string;
  source_url?: string;
  idempotency_key: string;
}

export interface CapturedNotePatch {
  note?: string;
  selection_type?: CaptureSelectionType;
  status?: "inbox" | "saved" | "dismissed";
}

export interface CapturedNotePromotion {
  note_id: string;
  normalized_word: string;
  is_new: boolean;
}

export function newCaptureIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function newNoteReviewIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export type WebAction =
  | { action: "set_daily_time_budget"; minutes: number; expected_revision: string | null }
  | { action: "extend_daily_time_budget"; request_id: string; expected_revision: string | null }
  | { action: "set_daily_new_word_limit"; limit: number; expected_revision: string | null }
  | { action: string; expected_revision: string | null; [key: string]: unknown };

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  clearReadModelCache();
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  clearReadModelCache();
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable in private browsing; the in-memory token still works for this page.
  }
}

async function request<T = WebApiResponse>(path: string, init: RequestInit, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? storedToken();
  if (!token) throw new UnauthorizedError();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError("REQUEST_TIMEOUT", "请求等待过久。操作可能已保存，请刷新状态后继续。", 0));
    }, WEB_REQUEST_TIMEOUT_MS);
  });
  try {
  const response = await Promise.race([fetch(path, { ...init, headers, signal: controller.signal, cache: "no-store" }), deadline]);
  let payload: T & { error?: { code: string; message: string } };
  try {
    payload = await Promise.race([response.json(), deadline]) as T & { error?: { code: string; message: string } };
  } catch {
    if (controller.signal.aborted && !init.signal?.aborted) throw new ApiError("REQUEST_TIMEOUT", "请求等待过久。操作可能已保存，请刷新状态后继续。", 0);
    throw new ApiError("INVALID_RESPONSE", "服务器返回了无法读取的响应。", response.status);
  }
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 409 && payload.error?.code === "STALE_STUDY_STATE") throw new StaleStudyStateError();
  if (!response.ok) {
    throw new ApiError(
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? "请求失败，请重试。",
      response.status,
    );
  }
  return payload;
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new ApiError("REQUEST_TIMEOUT", "请求等待过久。操作可能已保存，请刷新状态后继续。", 0);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export function getBootstrap(tokenOverride?: string): Promise<WebApiResponse> {
  return request("/api/web/bootstrap", { method: "GET" }, tokenOverride);
}

export function postAction(action: WebAction): Promise<WebApiResponse> {
  clearReadModelCache();
  return request("/api/web/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
}


export interface CaptureOccurrence {
  context_text: string;
  source_type: string;
  source_ref: string | null;
  source_title: string | null;
  source_url: string | null;
  created_at: string;
}

export interface ReadModelEnvelope<T> {
  data: T;
  as_of: string;
  timezone: string;
  definition_version: "wordloop-analytics-v1";
  coverage: Record<string, unknown>;
  next_cursor?: string | null;
}

export interface TodayOverview {
  as_of: string;
  timezone: string;
  target_retention: number;
  active_session: { active: boolean; phase: string; phase_detail: string | null; started_at: string | null; updated_at: string | null };
  progress: {
    review: { completed: number; total: number; remaining: number; scope: "active_session" | "today_recorded_sessions" };
    pretest: { total: number; completed: number; known: number; uncertain: number; unknown: number };
    formal_learning: { completed_words: number; completed_distinct_words: number; new_words: number; relearn_words: number };
  };
  captures: { inbox_count: number };
}

export interface CaptureNote {
  id: string;
  selected_text: string;
  normalized_text: string;
  selection_type: string;
  note: string;
  status: CaptureStatus;
  occurrence_count: number;
  user_word_id: string | null;
  word_id: string | null;
  created_at: string;
  updated_at: string;
  first_seen_at: string;
  last_seen_at: string;
  latest_occurrence: CaptureOccurrence | null;
  occurrences: CaptureOccurrence[];
  note_review: { enabled: boolean; due: string | null; revision: number } | null;
}

export interface CaptureListResponse {
  items: CaptureNote[];
  counts: Record<CaptureStatus, number>;
  next_cursor: string | null;
}

export interface CaptureOccurrencePage {
  items: CaptureOccurrence[];
  total: number;
  next_cursor: string | null;
}

export interface CaptureMutationResponse {
  item: CaptureNote;
  learning_update?: { scheduled_today: boolean; existing_status: string | null };
}

export interface NoteReviewOccurrence {
  context_text: string;
  source_type: string;
  source_title: string | null;
  source_url: string | null;
  captured_at: string;
}

export interface NoteReviewItem {
  note_id: string;
  selected_text: string;
  note: string;
  note_updated_at: string;
  due: string;
  revision: number;
  latest_occurrence: NoteReviewOccurrence | null;
}

export interface NoteReviewListResponse {
  items: NoteReviewItem[];
  total: number;
  as_of: string;
}

export interface NoteReviewStateResponse {
  note_id: string;
  enabled: boolean;
  due: string | null;
  revision: number | null;
  card: Record<string, unknown> | null;
  rating?: NoteReviewRating;
  server_time?: string;
  replayed?: boolean;
}

async function captureRequest<T>(path: string, init: RequestInit): Promise<T> {
  if ((init.method ?? "GET").toUpperCase() !== "GET") clearReadModelCache();
  const token = storedToken();
  if (!token) throw new UnauthorizedError();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("INVALID_RESPONSE", "服务器返回了无法读取的响应。", response.status);
  }
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    const error = typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: { code?: string; message?: string } }).error
      : undefined;
    throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "请求失败，请重试。", response.status);
  }
  return payload as T;
}

async function readModel<T>(path: string, signal?: AbortSignal): Promise<T> {
  const cached = readModelCache.get(path);
  if (cached && Date.now() - cached.stored_at < 60_000) return cached.value as T;
  const value = await captureRequest<T>(path, { method: "GET", signal });
  if (!signal?.aborted) readModelCache.set(path, { stored_at: Date.now(), value });
  return value;
}

export function getTodayOverview(signal?: AbortSignal): Promise<TodayOverview> {
  return readModel<TodayOverview>("/api/web/today", signal);
}

export function getAnalytics<T = Record<string, unknown>>(
  section: "overview" | "memory" | "weakness" | "activity",
  range: "7d" | "30d" | "90d" = "30d",
  cursor = "",
  limit = 50,
  signal?: AbortSignal,
): Promise<ReadModelEnvelope<T>> {
  const params = new URLSearchParams({ section, range, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return readModel<ReadModelEnvelope<T>>(`/api/web/analytics?${params.toString()}`, signal);
}

export interface VocabularyListItem {
  user_word_id: string;
  word_id: string;
  word: string;
  display_word: string;
  ipa_us: string | null;
  ipa_uk: string | null;
  status: string;
  source: string | null;
  fsrs_reps: number;
  fsrs_difficulty: number | null;
  fsrs_stability: number | null;
  next_review_at: string | null;
  active_error_layers: string[];
}

export function getVocabularyPage(
  q: string,
  filters: readonly string[],
  cursor = "",
  limit = 50,
  signal?: AbortSignal,
): Promise<ReadModelEnvelope<{ items: VocabularyListItem[] }>> {
  const params = new URLSearchParams({ q, cursor, limit: String(limit) });
  for (const filter of filters) params.append("filter", filter);
  return readModel(`/api/web/vocabulary?${params.toString()}`, signal);
}

export function getVocabularyDetail<T = Record<string, unknown>>(userWordId: string, signal?: AbortSignal): Promise<ReadModelEnvelope<T>> {
  return readModel(`/api/web/vocabulary/${encodeURIComponent(userWordId)}`, signal);
}

export function getCaptureNotes(
  status?: CaptureStatus,
  limit = 50,
  q = "",
  cursor = "",
  signal?: AbortSignal,
): Promise<CaptureListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return captureRequest<CaptureListResponse>(`/api/web/captures?${params.toString()}`, { method: "GET", signal });
}

export function createCaptureNote(input: {
  selected_text: string;
  context_text?: string;
  selection_type?: CaptureSelectionType;
  source_type?: CaptureSourceType;
  source_ref?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  idempotency_key: string;
}): Promise<CaptureMutationResponse> {
  return captureRequest<CaptureMutationResponse>("/api/web/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getCaptureNote(id: string): Promise<{ item: CaptureNote }> {
  return captureRequest<{ item: CaptureNote }>(`/api/web/captures/${encodeURIComponent(id)}`, { method: "GET" });
}

export function getCaptureNoteOccurrences(
  id: string,
  limit = 50,
  cursor = "",
  signal?: AbortSignal,
): Promise<CaptureOccurrencePage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return captureRequest<CaptureOccurrencePage>(`/api/web/captures/${encodeURIComponent(id)}/occurrences?${params}`, { method: "GET", signal });
}

export function updateCaptureNote(
  id: string,
  input: { note?: string; selection_type?: CaptureSelectionType; status?: "inbox" | "saved" | "archived" | "dismissed" },
): Promise<CaptureMutationResponse> {
  return captureRequest<CaptureMutationResponse>(`/api/web/captures/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function addCaptureNoteToLearning(id: string): Promise<CaptureMutationResponse> {
  return captureRequest<CaptureMutationResponse>(`/api/web/captures/${encodeURIComponent(id)}/learn`, {
    method: "POST",
  });
}

export function getNoteReviews(signal?: AbortSignal): Promise<NoteReviewListResponse> {
  return captureRequest<NoteReviewListResponse>("/api/web/note-reviews", { method: "GET", signal });
}

export function setNoteReviewEnabled(id: string, enabled: boolean): Promise<NoteReviewStateResponse> {
  return captureRequest<NoteReviewStateResponse>(`/api/web/captures/${encodeURIComponent(id)}/note-review`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function rateNoteReview(
  id: string,
  input: {
    rating: NoteReviewRating;
    expected_revision: number;
    expected_note_updated_at: string;
    idempotency_key: string;
  },
): Promise<NoteReviewStateResponse> {
  return captureRequest<NoteReviewStateResponse>(`/api/web/captures/${encodeURIComponent(id)}/note-review/ratings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

function toLegacyCapturedNote(note: CaptureNote): CapturedNote {
  return {
    id: note.id,
    selected_text: note.selected_text,
    normalized_text: note.normalized_text,
    selection_type: note.selection_type as CaptureSelectionType,
    note: note.note,
    status: note.status === "learning" ? "converted" : note.status === "archived" ? "dismissed" : note.status,
    converted_user_word_id: note.user_word_id,
    created_at: note.created_at,
    updated_at: note.updated_at,
    occurrence_count: note.occurrence_count,
    occurrences: note.occurrences.map((occurrence) => ({
      context_text: occurrence.context_text,
      source_type: occurrence.source_type as CaptureSourceType,
      source_title: occurrence.source_title,
      source_url: occurrence.source_url,
      captured_at: occurrence.created_at,
    })),
  };
}

export async function getCapturedNotes(input: {
  status: LegacyCaptureStatus | "all";
  q?: string;
  cursor?: string | null;
}): Promise<CapturedNotePage> {
  const status: CaptureStatus | undefined = input.status === "converted" ? "learning"
    : input.status === "dismissed" ? "archived"
      : input.status === "all" ? undefined
        : input.status;
  const page = await getCaptureNotes(status, 25, input.q ?? "", input.cursor ?? "");
  return { items: page.items.map(toLegacyCapturedNote), next_cursor: page.next_cursor };
}

export function createCapturedNote(input: CaptureCreateInput): Promise<{
  note_id: string;
  occurrence_count: number;
  new_occurrence: boolean;
}> {
  return captureRequest("/api/web/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateCapturedNote(id: string, patch: CapturedNotePatch): Promise<{ id: string }> {
  const status = patch.status === "dismissed" ? "archived" : patch.status;
  const response = await updateCaptureNote(id, { ...patch, status });
  return { id: response.item.id };
}

export function promoteCapturedNote(id: string): Promise<CapturedNotePromotion> {
  return captureRequest<CapturedNotePromotion>(`/api/web/captures/${encodeURIComponent(id)}/promote`, { method: "POST" });
}

export function getBudget(): Promise<import("../../../server/services/learningBudget.js").BudgetSnapshot> {
  return request("/api/web/budget", { method: "GET" });
}
export function getEvidenceReport(): Promise<any> { return request("/api/web/evidence", { method: "GET" }); }
export function saveEvidenceLabel(id: number, outcome: string, error_label: string): Promise<{ saved: boolean }> {
  return request("/api/web/evidence/label", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, outcome, error_label }) });
}
