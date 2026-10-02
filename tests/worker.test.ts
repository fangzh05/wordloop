import { describe, expect, it } from "vitest";
import worker from "../server/worker.js";
import { LESSON_WIDGET_VERSION } from "../shared/toolContracts.js";
import { WIDGET_URIS } from "../server/tools/renderWidgets.js";

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

  it("serves the standalone PWA shell and manifest with static caching", async () => {
    const html = await worker.fetch(new Request(`${testOrigin}/`), {});
    expect(html.status).toBe(200);
    expect(html.headers.get("cache-control")).toBe("no-cache");
    expect(await html.text()).toContain("Wordloop");

    const manifest = await worker.fetch(new Request(`${testOrigin}/manifest.webmanifest`), {});
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("public, max-age=3600");
    await expect(manifest.json()).resolves.toEqual({});
  });

  it("protects the Web API without adding CORS while leaving MCP independent of the Web token", async () => {
    const bootstrap = await worker.fetch(new Request(`${testOrigin}/api/web/bootstrap`), {
      WORDLOOP_WEB_TOKEN: "worker-test-token",
    });
    expect(bootstrap.status).toBe(401);
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();

    const mcp = await worker.fetch(new Request(`${testOrigin}/api/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }), { WORDLOOP_WEB_TOKEN: "worker-test-token" });
    expect(mcp.status).toBe(200);
    expect(mcp.headers.get("access-control-allow-origin")).toBe("*");
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
    expect(payload.result.tools).toHaveLength(33);
    expect(payload.result.tools.some((tool) => tool.name === "get_learning_context")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "get_next_learning_word")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_pretest_widget")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "pretest_mark_familiar")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_review_widget")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_review_widget_v2")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "record_review_result")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "record_review_submission")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "record_attempt")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "record_pretest_result")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "import_shanbay_book")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_learning_dashboard")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "render_lesson_widget")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "get_active_study_session")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "get_study_bootstrap")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "advance_study_session")).toBe(true);
    expect(payload.result.tools.some((tool) => tool.name === "finish_study_session")).toBe(true);
    expect(WIDGET_URIS.lesson).toBe("ui://wordloop/lesson-v9.html");
    expect(LESSON_WIDGET_VERSION).toBe(3);
  });
});
