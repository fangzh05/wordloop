const TOKEN_KEY = "wordloop_web_token";
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
  pronunciation_audio_url?: string | null;
  result?: { is_correct: boolean; error_layer: string; message?: string };
  pretest_summary?: { known: number; uncertain: number; unknown: number };
  pretest_results?: Array<{ word: string; status: string }>;
  message?: string;
  error?: { code: string; message: string };
}

export type WebAction =
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

async function request(path: string, init: RequestInit, tokenOverride?: string): Promise<WebApiResponse> {
  const token = tokenOverride ?? storedToken();
  if (!token) throw new UnauthorizedError();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  let payload: WebApiResponse;
  try {
    payload = await response.json() as WebApiResponse;
  } catch {
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


export type CaptureStatus = "inbox" | "saved" | "learning" | "archived";
export type CaptureSelectionType = "word" | "phrase" | "collocation" | "sentence" | "grammar";
export type CaptureSourceType = "lesson_example" | "lesson_prompt" | "review_question" | "manual" | "lesson" | "review" | "pretest" | "dashboard";

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
  input: { note?: string; status?: "inbox" | "saved" | "archived" },
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
