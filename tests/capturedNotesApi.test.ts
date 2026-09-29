import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: "capture-test-token" as string | undefined,
  userId: "00000000-0000-4000-8000-000000000001",
  listCaptureNotes: vi.fn(),
  createCaptureNote: vi.fn(),
  updateCaptureNote: vi.fn(),
  addCaptureNoteToLearning: vi.fn(),
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

vi.mock("../server/services/captureNotes.js", () => ({
  CaptureServiceError: class CaptureServiceError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  },
  listCaptureNotes: mocks.listCaptureNotes,
  createCaptureNote: mocks.createCaptureNote,
  updateCaptureNote: mocks.updateCaptureNote,
  addCaptureNoteToLearning: mocks.addCaptureNoteToLearning,
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

const note = {
  id: "00000000-0000-4000-8000-000000000002",
  selected_text: "recur",
  normalized_text: "recur",
  selection_type: "word",
  note: "",
  status: "inbox",
  occurrence_count: 1,
  user_word_id: null,
  word_id: null,
  created_at: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-09-30T00:00:00.000Z",
  first_seen_at: "2026-09-30T00:00:00.000Z",
  last_seen_at: "2026-09-30T00:00:00.000Z",
  latest_occurrence: null,
  occurrences: [],
  new_occurrence: true,
};

describe("Capture Web API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.token = "capture-test-token";
    mocks.listCaptureNotes.mockResolvedValue({
      items: [],
      counts: { inbox: 0, saved: 0, learning: 0, archived: 0 },
      next_cursor: null,
    });
    mocks.createCaptureNote.mockResolvedValue(note);
    mocks.updateCaptureNote.mockResolvedValue(note);
    mocks.addCaptureNoteToLearning.mockResolvedValue({ note, scheduled_today: true, existing_status: null });
  });

  it("lists captures with no-store responses and does not load or revise the study session", async () => {
    const response = await handleWebApiRequest(request("/api/web/captures?status=inbox&q=example&cursor=25"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await payload(response)).toMatchObject({ items: [], next_cursor: null, counts: { inbox: 0 } });
    expect(mocks.listCaptureNotes).toHaveBeenCalledWith({ status: "inbox", q: "example", cursor: "25", limit: 50 });
    expect(mocks.getActiveStudySession).not.toHaveBeenCalled();
    expect(mocks.assertActiveStudySessionRevision).not.toHaveBeenCalled();
  });

  it("creates a capture on its own route without study revision fields", async () => {
    const input = { selected_text: "recur", selection_type: "word", idempotency_key: "00000000-0000-4000-8000-000000000003" };
    const response = await handleWebApiRequest(request("/api/web/captures", "POST", input));
    expect(response.status).toBe(201);
    expect(await payload(response)).toMatchObject({ note_id: note.id, item: { id: note.id }, new_occurrence: true });
    expect(mocks.createCaptureNote).toHaveBeenCalledWith(input);
    expect(mocks.assertActiveStudySessionRevision).not.toHaveBeenCalled();
  });

  it("updates and promotes a capture through separate endpoints", async () => {
    const update = await handleWebApiRequest(request("/api/web/captures/00000000-0000-4000-8000-000000000002", "PATCH", { status: "saved" }));
    const promotion = await handleWebApiRequest(request("/api/web/captures/00000000-0000-4000-8000-000000000002/promote", "POST"));
    expect(update.status).toBe(200);
    expect(promotion.status).toBe(200);
    expect(mocks.updateCaptureNote).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", { status: "saved" });
    expect(mocks.addCaptureNoteToLearning).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    expect(mocks.assertActiveStudySessionRevision).not.toHaveBeenCalled();
  });

  it("requires the configured bearer token for Capture routes", async () => {
    const response = await handleWebApiRequest(new Request("https://wordloop.test/api/web/captures"));
    expect(response.status).toBe(401);
    expect(mocks.listCaptureNotes).not.toHaveBeenCalled();
  });
});
