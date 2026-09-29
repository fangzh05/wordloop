import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: "capture-test-token" as string | undefined,
  userId: "00000000-0000-4000-8000-000000000001",
  listCapturedNotes: vi.fn(),
  createCapturedNote: vi.fn(),
  updateCapturedNote: vi.fn(),
  promoteCapturedNote: vi.fn(),
  assertActiveStudySessionRevision: vi.fn(),
  getActiveStudySession: vi.fn(),
}));

vi.mock("../server/db.js", async () => {
  const actual = await vi.importActual<typeof import("../server/db.js")>("../server/db.js");
  return {
    ...actual,
    getAuthenticatedUserId: () => mocks.userId,
    getWordloopWebToken: () => mocks.token,
  };
});

vi.mock("../server/services/capturedNotes.js", () => ({
  CapturedNotesError: class CapturedNotesError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  },
  listCapturedNotes: mocks.listCapturedNotes,
  createCapturedNote: mocks.createCapturedNote,
  updateCapturedNote: mocks.updateCapturedNote,
  promoteCapturedNote: mocks.promoteCapturedNote,
}));

vi.mock("../server/services/studySessions.js", async () => {
  const actual = await vi.importActual<typeof import("../server/services/studySessions.js")>("../server/services/studySessions.js");
  return {
    ...actual,
    assertActiveStudySessionRevision: mocks.assertActiveStudySessionRevision,
    getActiveStudySession: mocks.getActiveStudySession,
  };
});

import { handleWebApiRequest } from "../server/webApi.js";

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://wordloop.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${mocks.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function payload(response: Response): Promise<any> {
  return response.json();
}

describe("Capture Web API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.token = "capture-test-token";
    mocks.listCapturedNotes.mockResolvedValue({ items: [], next_cursor: null });
    mocks.createCapturedNote.mockResolvedValue({ note_id: "capture-1", occurrence_count: 1, new_occurrence: true });
    mocks.updateCapturedNote.mockResolvedValue({ id: "capture-1" });
    mocks.promoteCapturedNote.mockResolvedValue({ note_id: "capture-1", normalized_word: "recur", is_new: true });
  });

  it("lists captures with no-store responses and does not load or revise the study session", async () => {
    const response = await handleWebApiRequest(request("/api/web/captures?status=inbox&q=example&cursor=25"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await payload(response)).toEqual({ items: [], next_cursor: null });
    expect(mocks.listCapturedNotes).toHaveBeenCalledWith({ status: "inbox", q: "example", cursor: "25" });
    expect(mocks.getActiveStudySession).not.toHaveBeenCalled();
    expect(mocks.assertActiveStudySessionRevision).not.toHaveBeenCalled();
  });

  it("creates a capture on its own route without study revision fields", async () => {
    const input = { selected_text: "recur", selection_type: "word", idempotency_key: "key" };
    const response = await handleWebApiRequest(request("/api/web/captures", "POST", input));
    expect(response.status).toBe(201);
    expect(await payload(response)).toMatchObject({ note_id: "capture-1" });
    expect(mocks.createCapturedNote).toHaveBeenCalledWith(input);
    expect(mocks.assertActiveStudySessionRevision).not.toHaveBeenCalled();
  });

  it("updates and promotes a capture through separate endpoints", async () => {
    const update = await handleWebApiRequest(request("/api/web/captures/00000000-0000-4000-8000-000000000002", "PATCH", { status: "saved" }));
    const promotion = await handleWebApiRequest(request("/api/web/captures/00000000-0000-4000-8000-000000000002/promote", "POST"));
    expect(update.status).toBe(200);
    expect(promotion.status).toBe(200);
    expect(mocks.updateCapturedNote).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", { status: "saved" });
    expect(mocks.promoteCapturedNote).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    expect(mocks.assertActiveStudySessionRevision).not.toHaveBeenCalled();
  });

  it("requires the configured bearer token for Capture routes", async () => {
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/captures"));
    expect(response.status).toBe(401);
    expect(mocks.listCapturedNotes).not.toHaveBeenCalled();
  });
});
