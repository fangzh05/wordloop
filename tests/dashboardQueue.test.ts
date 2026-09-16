import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureTodayQueue: vi.fn(),
  getProgress: vi.fn(),
}));

vi.mock("../server/services/dailyQueue.js", () => ({ ensureTodayQueue: mocks.ensureTodayQueue }));
vi.mock("../server/services/progress.js", () => ({ getProgress: mocks.getProgress }));

import { registerRenderTools } from "../server/tools/renderWidgets.js";

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "dashboard-queue-test", version: "1.0.0" });
  registerRenderTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dashboard-queue-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("learning dashboard daily queue guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureTodayQueue.mockResolvedValue({ date: "2026-09-16", prepared: 50, added: 50 });
    mocks.getProgress.mockResolvedValue({
      today: { total: 50, known: 0, uncertain: 0, unknown: 0, completed: 0 },
      all_time: { total_words: 50, mastered: 0, learning: 50, error_book: 0 },
      fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 },
      settings: { daily_new_word_limit: 50 },
    });
  });

  it("ensures today's queue before reading the progress snapshot", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "render_learning_dashboard", arguments: {} });
      expect(result.isError).not.toBe(true);
    });

    expect(mocks.ensureTodayQueue).toHaveBeenCalledOnce();
    expect(mocks.getProgress).toHaveBeenCalledOnce();
    expect(mocks.ensureTodayQueue.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.getProgress.mock.invocationCallOrder[0]!);
  });
});
