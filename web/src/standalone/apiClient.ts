const TOKEN_KEY = "wordloop_web_token";

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
  result?: { status?: string; user_answer?: string; is_correct?: boolean; error_layer?: string; mark_familiar?: boolean; message?: string };
  pretest_summary?: { known: number; uncertain: number; unknown: number };
  pretest_result?: { word: string; status: string; user_answer?: string; is_correct?: boolean; error_layer?: string };
  pretest_results?: Array<{ word: string; status: string; user_answer?: string; is_correct?: boolean; error_layer?: string }>;
  message?: string;
  error?: { code: string; message: string };
}

export type CaptureSelectionType = "word" | "phrase" | "collocation" | "sentence" | "grammar";
export type CaptureStatus = "inbox" | "saved" | "dismissed" | "converted";
export type CaptureSourceType = "lesson_example" | "lesson_prompt" | "review_question" | "manual";

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
  status: CaptureStatus;
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
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
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
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  let payload: T & { error?: { code: string; message: string } };
  try {
    payload = await response.json() as T & { error?: { code: string; message: string } };
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
  return request("/api/web/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
}

export function getCapturedNotes(input: {
  status: CaptureStatus | "all";
  q?: string;
  cursor?: string | null;
}): Promise<CapturedNotePage> {
  const query = new URLSearchParams({ status: input.status });
  if (input.q) query.set("q", input.q);
  if (input.cursor !== undefined && input.cursor !== null) query.set("cursor", input.cursor);
  return request<CapturedNotePage>(`/api/web/captures?${query.toString()}`, { method: "GET" });
}

export function createCapturedNote(input: CaptureCreateInput): Promise<{
  note_id: string;
  occurrence_count: number;
  new_occurrence: boolean;
}> {
  return request("/api/web/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateCapturedNote(id: string, patch: CapturedNotePatch): Promise<{ id: string }> {
  return request(`/api/web/captures/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function promoteCapturedNote(id: string): Promise<CapturedNotePromotion> {
  return request(`/api/web/captures/${encodeURIComponent(id)}/promote`, { method: "POST" });
}
