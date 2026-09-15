import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReviewSelection } from "../server/services/review.js";
import { registerRenderTools } from "../server/tools/renderWidgets.js";
import type { ReviewVocabularyItem } from "../server/types.js";

vi.mock("../server/services/review.js", () => ({
  getReviewSelection: vi.fn(),
}));

const mockedGetReviewSelection = vi.mocked(getReviewSelection);

function reviewItem(word: string, nextReviewAt = "2026-09-12T00:00:00Z"): ReviewVocabularyItem {
  return {
    word,
    display_word: word,
    status: "review",
    source: "test",
    consecutive_correct: 0,
    wrong_count: 0,
    mastered: false,
    next_review_at: nextReviewAt,
    error_layers: [],
    fsrs_stability: 3,
    fsrs_difficulty: 5,
    fsrs_scheduled_days: 2,
    fsrs_state: 2,
    is_due: true,
    review_kind: "fsrs_due",
    senses: [{ pos: "n.", definition_cn: "测试含义" }],
  };
}

async function withReviewClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "review-tool-test", version: "1.0.0" });
  registerRenderTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "review-tool-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function payloadOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

describe("Review render tool schema compatibility", () => {
  beforeEach(() => {
    mockedGetReviewSelection.mockReset();
  });

  it("accepts legacy items but never returns the fake word", async () => {
    mockedGetReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({
        name: "render_review_widget",
        arguments: {
          items: [{ word: "fake-word", meaning_zh: "伪造词", direction: "cn_to_en", error_layers: [] }],
          title: "伪造标题",
        },
      });
      const payload = payloadOf(result);
      expect(JSON.stringify(payload)).not.toContain("fake-word");
      expect((payload.items as Array<{ word: string }>).map((item) => item.word)).toEqual(["backend-word"]);
    });
  });

  it("accepts an empty legacy call", async () => {
    mockedGetReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({ name: "render_review_widget", arguments: {} });
      expect(payloadOf(result).widget).toBe("review");
    });
  });

  it("accepts an empty v2 call", async () => {
    mockedGetReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const result = await client.callTool({ name: "render_review_widget_v2", arguments: {} });
      expect(payloadOf(result).widget).toBe("review");
    });
  });

  it("keeps the legacy and v2 payloads identical", async () => {
    mockedGetReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("backend-word"), reviewItem("second-word")],
      oldRandomReview: [],
    });

    await withReviewClient(async (client) => {
      const legacy = payloadOf(await client.callTool({ name: "render_review_widget", arguments: {} }));
      const v2 = payloadOf(await client.callTool({ name: "render_review_widget_v2", arguments: {} }));
      expect(v2).toEqual(legacy);
      expect(mockedGetReviewSelection).toHaveBeenCalledWith(5);
    });
  });

  it("does not pad a short backend queue with future cards", async () => {
    mockedGetReviewSelection.mockResolvedValue({
      rollingReview: [reviewItem("due-word"), reviewItem("error-word")],
      oldRandomReview: [reviewItem("future-word", "2099-01-01T00:00:00Z")],
    });

    await withReviewClient(async (client) => {
      const payload = payloadOf(await client.callTool({
        name: "render_review_widget_v2",
        arguments: { current_index: 4 },
      }));
      expect((payload.items as Array<{ word: string }>).map((item) => item.word)).toEqual(["due-word", "error-word"]);
      expect(payload.current_index).toBe(1);
      expect(JSON.stringify(payload)).not.toContain("future-word");
    });
  });
});
