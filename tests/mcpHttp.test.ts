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
      "import_words", "get_learning_context", "get_next_learning_word", "get_next_round", "record_pretest_result",
      "record_attempt", "get_error_book", "save_sentence", "get_progress",
      "record_review_result", "record_review_submission",
      "render_word_import", "render_pretest_widget", "render_review_widget", "render_review_widget_v2", "render_learning_dashboard", "render_lesson_widget", "render_pronunciation_cards", "render_dictation_widget",
      "get_active_study_session", "get_study_bootstrap", "advance_study_session", "finish_study_session",
    ]));
    expect(instructions).toContain("active error");
    expect(instructions).toContain("Prefer render_review_widget_v2");
    expect(instructions).toContain("legacy render_review_widget");
    expect(instructions).toContain("next_review_at is due");
    expect(instructions).toContain("record_review_result");
    expect(instructions).toContain("record_review_submission");
    expect(instructions).toContain("原子");
    expect(instructions).toContain("Lesson navigation is backend-owned and authoritative");
    expect(instructions).toContain("lesson_complete");
    expect(instructions).toContain("round_complete means one vocabulary ROUND has ended, not that the whole study SESSION has ended");
    expect(instructions).toContain("After WORDLOOP_ROUND_COMPLETE");
    expect(instructions).toContain("do not emit two equivalent wrap-up prompts");
    expect(instructions).toContain("round_complete 只触发长难句收尾，不得触发会话收尾");
    expect(instructions).toContain("会话收尾必须由用户明确结束学习触发");
    expect(instructions).toContain("If it returns { action: \"done\" } for an active lesson_complete state");
    expect(instructions).toContain("do not repeat the round-complete handoff");
    const bootstrapTool = response.tools.find((tool) => tool.name === "get_study_bootstrap");
    expect(bootstrapTool?.description).toContain("active Lesson phase=lesson_complete");
    expect(bootstrapTool?.description).toContain("不表示整个 session 或今天的学习完成");
    expect(bootstrapTool?.description).toContain("不得因此触发会话末自由回忆");
    const reviewSubmissionTool = response.tools.find((tool) => tool.name === "record_review_submission");
    expect(reviewSubmissionTool?._meta).toMatchObject({
      ui: { resourceUri: "ui://wordloop/review.html", visibility: ["app"] },
      "ui/resourceUri": "ui://wordloop/review.html",
    });
    const reviewSubmissionInput = reviewSubmissionTool?.inputSchema as { required?: string[] };
    expect(reviewSubmissionInput.required ?? []).toContain("direction");
    const missingDirection = await client.callTool({
      name: "record_review_submission",
      arguments: { word: "recur", is_correct: false, error_layer: "meaning", rating: "again" },
    });
    expect(missingDirection.isError).toBe(true);
    expect(JSON.stringify(missingDirection.content)).toMatch(/direction/i);
    const contextTool = response.tools.find((tool) => tool.name === "get_learning_context");
    expect(contextTool?.description).toContain("prefer render_review_widget_v2");
    expect(contextTool?.description).toContain("legacy render_review_widget");
    const reviewTool = response.tools.find((tool) => tool.name === "record_review_result");
    expect(reviewTool?.description).toContain("next_review_at is due");
    expect(reviewTool?.description).toContain("not-yet-due error repair");
    expect(reviewTool?.description).toContain("default 20-word quiz questions");
    expect(reviewTool?.description).toContain("end-of-session free recall");
    expect(reviewTool?.description).toContain("learning or relearning step");
    const reviewRenderTool = response.tools.find((tool) => tool.name === "render_review_widget");
    expect(reviewRenderTool?.description).toContain("兼容旧客户端");
    expect(reviewRenderTool?.description).toContain("传入 items 会被忽略");
    expect(reviewRenderTool?.description).toContain("实际复习队列由 WordLoop backend 生成");
    expect(JSON.stringify(reviewRenderTool?._meta ?? {})).toContain("ui://wordloop/review.html");
    const reviewInput = reviewRenderTool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(reviewInput.properties).toHaveProperty("items");
    expect(reviewInput.properties).toHaveProperty("current_index");
    expect(reviewInput.properties).toHaveProperty("title");
    expect(reviewInput.required ?? []).not.toContain("items");
    const reviewV2Tool = response.tools.find((tool) => tool.name === "render_review_widget_v2");
    expect(JSON.stringify(reviewV2Tool?._meta ?? {})).toContain("ui://wordloop/review.html");
    const reviewV2Input = reviewV2Tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(reviewV2Input.properties).toHaveProperty("current_index");
    expect(reviewV2Input.properties).not.toHaveProperty("items");
    expect(reviewV2Input.properties).not.toHaveProperty("title");
    const activeSessionTool = response.tools.find((tool) => tool.name === "get_active_study_session");
    expect(activeSessionTool?.inputSchema).toMatchObject({ type: "object" });
    const advanceTool = response.tools.find((tool) => tool.name === "advance_study_session");
    expect(JSON.stringify(advanceTool?.inputSchema)).toContain("lesson_start_exercise");
    expect(JSON.stringify(advanceTool?.inputSchema)).toContain("lesson_retry");
    const finishTool = response.tools.find((tool) => tool.name === "finish_study_session");
    expect(finishTool?.inputSchema).toMatchObject({ type: "object" });
    const lessonTool = response.tools.find((tool) => tool.name === "render_lesson_widget");
    expect(JSON.stringify(lessonTool?._meta ?? {})).toContain("ui://wordloop/lesson-v5.html");
    expect(JSON.stringify(lessonTool?.inputSchema)).toContain("resume");
    const lessonInput = lessonTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(lessonInput?.properties).not.toHaveProperty("navigation");
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    expect(resourceUris).toEqual(expect.arrayContaining([
      "ui://wordloop/lesson-v5.html",
      "ui://wordloop/lesson-v4.html",
      "ui://wordloop/lesson-v3.html",
      "ui://wordloop/lesson-v2.html",
      "ui://wordloop/lesson.html",
    ]));
    const nextLearningTool = response.tools.find((tool) => tool.name === "get_next_learning_word");
    expect(nextLearningTool?.description).toContain('action="next_word"');
    expect(nextLearningTool?.description).toContain('action="round_complete"');
    expect(nextLearningTool?.description).toContain("this is SUCCESS, not an error");
    const nextLearningOutput = nextLearningTool?.outputSchema as {
      type?: string;
      properties?: Record<string, { type?: string; enum?: string[]; anyOf?: Array<{ type?: string }> }>;
      required?: string[];
    } | undefined;
    expect(nextLearningOutput?.type).toBe("object");
    expect(nextLearningOutput?.properties?.action).toEqual({
      type: "string",
      enum: ["next_word", "round_complete"],
    });
    expect(nextLearningOutput?.properties?.next_word?.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "object" }),
      expect.objectContaining({ type: "null" }),
    ]));
    expect(nextLearningOutput?.properties?.round_complete).toEqual({ type: "boolean" });
    expect(nextLearningOutput?.required ?? []).toEqual(expect.arrayContaining([
      "action", "next_word", "round_complete",
    ]));
    const invalidLesson = await client.callTool({
      name: "render_lesson_widget",
      arguments: { mode: "exercise", word: "plantation", activity_type: "sentence", instruction: "Use it.", multiline: false },
    });
    expect(invalidLesson.isError).toBe(true);
    await client.close();
  });
});
