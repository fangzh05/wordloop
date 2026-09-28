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
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
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
  return request("/api/web/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
}
