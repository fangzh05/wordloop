import { describe, expect, it } from "vitest";
import worker from "../server/worker.js";

const testOrigin = "https://wordloop.test";

describe("Sites Worker", () => {
  it("serves health status from the public origin", async () => {
    const result = await worker.fetch(new Request(`${testOrigin}/health`), {});
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      name: "wordloop",
      status: "ok",
      mcp: "/api/mcp",
      version: "0.1.0",
    });
  });

  it("exposes all MCP tools through stateless Streamable HTTP", async () => {
    const result = await worker.fetch(new Request(`${testOrigin}/api/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), {});
    const payload = await result.json() as { result: { tools: Array<{ name: string }> } };
    expect(result.status).toBe(200);
    expect(payload.result.tools).toHaveLength(19);
    expect(payload.result.tools.some((tool) => tool.name === "get_learning_context")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_pretest_widget")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "record_review_result")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "import_shanbay_book")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_learning_dashboard")).toBe(true);
  });
});
