import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../server/index.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const instance = createHttpApp().listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("Streamable HTTP server", () => {
  it("returns health status", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "wordloop", status: "ok", mcp: "/mcp" });
  });

  it("initializes and lists focused data and render tools", async () => {
    const client = new Client({ name: "wordloop-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("没有输出 = 没有学会");
    expect(instructions).toContain("每词至少覆盖一道输出题");
    expect(instructions).toContain("每完成2轮做一次听写");
    expect(instructions).toContain("长难句收尾");
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "import_words", "get_learning_context", "get_next_round", "record_pretest_result",
      "record_attempt", "get_error_book", "save_sentence", "get_progress",
      "render_word_import", "render_pretest_widget", "render_review_widget", "render_learning_dashboard", "render_lesson_widget", "render_pronunciation_cards", "render_dictation_widget",
    ]));
    expect(instructions).toContain("active error");
    expect(instructions).toContain("next_review_at is due");
    expect(instructions).toContain("record_review_result");
    const reviewTool = response.tools.find((tool) => tool.name === "record_review_result");
    expect(reviewTool?.description).toContain("next_review_at is due");
    expect(reviewTool?.description).toContain("not-yet-due error repair");
    expect(reviewTool?.description).toContain("default 20-word quiz questions");
    expect(reviewTool?.description).toContain("end-of-session free recall");
    expect(reviewTool?.description).toContain("learning or relearning step");
    const reviewRenderTool = response.tools.find((tool) => tool.name === "render_review_widget");
    expect(JSON.stringify(reviewRenderTool?._meta ?? {})).toContain("ui://wordloop/review.html");
    const lessonTool = response.tools.find((tool) => tool.name === "render_lesson_widget");
    expect(JSON.stringify(lessonTool?._meta ?? {})).toContain("ui://wordloop/lesson.html");
    await client.close();
  });
});
