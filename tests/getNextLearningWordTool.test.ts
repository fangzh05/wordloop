import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mocks = vi.hoisted(() => ({
  getNextLearningWord: vi.fn(),
}));

vi.mock("../server/services/review.js", () => ({
  getNextLearningWord: mocks.getNextLearningWord,
}));

import { registerGetNextLearningWordTool } from "../server/tools/getNextLearningWord.js";

describe("get_next_learning_word MCP contract", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: "next-learning-word-test", version: "1.0.0" });
    registerGetNextLearningWordTool(server);
  });

  afterEach(async () => {
    await client?.close();
  });

  async function connect(): Promise<void> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "next-learning-word-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  it("publishes the output schema and keeps terminal completion a success result", async () => {
    mocks.getNextLearningWord.mockResolvedValue({
      action: "round_complete",
      next_word: null,
      round_complete: true,
    });
    await connect();

    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === "get_next_learning_word");
    const outputSchema = tool?.outputSchema as {
      type?: string;
      properties?: Record<string, { type?: string; enum?: string[]; anyOf?: Array<{ type?: string }> }>;
    } | undefined;
    expect(outputSchema?.type).toBe("object");
    expect(outputSchema?.properties?.action).toEqual({
      type: "string",
      enum: ["next_word", "round_complete"],
    });
    expect(outputSchema?.properties?.next_word?.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "object" }),
      expect.objectContaining({ type: "null" }),
    ]));
    expect(outputSchema?.properties?.round_complete).toEqual({ type: "boolean" });

    const result = await client.callTool({
      name: "get_next_learning_word",
      arguments: { current_word: "shrink" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      action: "round_complete",
      next_word: null,
      round_complete: true,
    });
  });

  it("keeps the next_word action valid with the backend lexical payload", async () => {
    mocks.getNextLearningWord.mockResolvedValue({
      action: "next_word",
      next_word: { word: "planet", status: "unknown", mastered: false },
      round_complete: false,
    });
    await connect();

    const result = await client.callTool({
      name: "get_next_learning_word",
      arguments: { current_word: "marine" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      action: "next_word",
      next_word: { word: "planet" },
      round_complete: false,
    });
  });
});
