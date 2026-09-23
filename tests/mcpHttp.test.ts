import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../server/index.js";
import { LEGACY_WIDGET_URIS, WIDGET_URIS } from "../server/tools/renderWidgets.js";
import { LESSON_WIDGET_VERSION } from "../shared/toolContracts.js";

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
    for (const token of [
      "get_study_bootstrap",
      "record_attempt",
      "record_review_submission",
      "round_complete",
      "finish_study_session",
      "resume",
      "wrapup",
    ]) {
      expect(instructions).toContain(token);
    }
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "import_words", "get_learning_context", "get_next_learning_word", "get_next_round", "record_pretest_result",
      "record_attempt", "get_error_book", "save_sentence", "get_progress",
      "record_review_result", "record_review_submission",
      "render_word_import", "render_pretest_widget", "render_review_widget", "render_review_widget_v2", "render_learning_dashboard", "render_lesson_widget", "render_pronunciation_cards", "render_dictation_widget",
      "get_active_study_session", "get_study_bootstrap", "advance_study_session", "finish_study_session",
    ]));
    const bootstrapTool = response.tools.find((tool) => tool.name === "get_study_bootstrap");
    expect(bootstrapTool?.description).toContain("active Lesson phase=lesson_complete 时只恢复现有 Lesson 收尾状态");
    expect(bootstrapTool?.description).not.toContain("action: done");
    expect(bootstrapTool?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
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
    expect(finishTool?.description).toContain("exactly once after the current Lesson round's long-sentence wrap-up");
    expect(finishTool?.description).toContain("immediately call get_study_bootstrap");
    expect(finishTool?.description).toContain("not the session-end free recall trigger");
    const lessonTool = response.tools.find((tool) => tool.name === "render_lesson_widget");
    expect(WIDGET_URIS.lesson).toBe("ui://wordloop/lesson-v7.html");
    expect(WIDGET_URIS.dictation).toBe("ui://wordloop/dictation-v2.html");
    expect(LEGACY_WIDGET_URIS.lessonV6).toBe("ui://wordloop/lesson-v6.html");
    expect(LEGACY_WIDGET_URIS.dictationV1).toBe("ui://wordloop/dictation.html");
    expect(LESSON_WIDGET_VERSION).toBe(3);
    expect(JSON.stringify(lessonTool?._meta ?? {})).toContain(WIDGET_URIS.lesson);
    expect(JSON.stringify(response.tools.find((tool) => tool.name === "render_dictation_widget")?._meta ?? {})).toContain(WIDGET_URIS.dictation);
    expect(lessonTool?.description).toContain("mode=exercise、wrapup=true");
    expect(lessonTool?.description).toContain("mode=feedback、wrapup=true");
    expect(JSON.stringify(lessonTool?.inputSchema)).toContain("resume");
    const lessonInput = lessonTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(lessonInput?.properties).not.toHaveProperty("navigation");
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    expect(resourceUris).toEqual(expect.arrayContaining([
      WIDGET_URIS.lesson,
      LEGACY_WIDGET_URIS.lessonV6,
      LEGACY_WIDGET_URIS.lessonV5,
      LEGACY_WIDGET_URIS.lessonV4,
      LEGACY_WIDGET_URIS.lessonV3,
      LEGACY_WIDGET_URIS.lessonV2,
      LEGACY_WIDGET_URIS.lesson,
      WIDGET_URIS.dictation,
      LEGACY_WIDGET_URIS.dictationV1,
    ]));
    const pronunciationUri = "ui://wordloop/pronunciation.html";
    const pronunciationResource = resources.resources.find((resource) => resource.uri === pronunciationUri);
    const expectedPronunciationUi = {
      prefersBorder: true,
      csp: {
        connectDomains: [],
        resourceDomains: [
          "https://media.merriam-webster.com",
          "https://dictionaryapi.com",
        ],
      },
    };
    expect((pronunciationResource?._meta as { ui?: unknown } | undefined)?.ui).toEqual(expectedPronunciationUi);
    const pronunciationRead = await client.readResource({ uri: pronunciationUri });
    const pronunciationContent = pronunciationRead.contents[0];
    const contentUi = (pronunciationContent?._meta as { ui?: unknown } | undefined)?.ui;
    expect(contentUi).toEqual(expectedPronunciationUi);
    expect(contentUi).toEqual((pronunciationResource?._meta as { ui?: unknown } | undefined)?.ui);
    for (const [kind, uris] of Object.entries({
      lesson: [WIDGET_URIS.lesson, LEGACY_WIDGET_URIS.lessonV6, LEGACY_WIDGET_URIS.lessonV5, LEGACY_WIDGET_URIS.lessonV4, LEGACY_WIDGET_URIS.lessonV3, LEGACY_WIDGET_URIS.lessonV2, LEGACY_WIDGET_URIS.lesson],
      dictation: [WIDGET_URIS.dictation, LEGACY_WIDGET_URIS.dictationV1],
    })) {
      let latestHtml: string | undefined;
      for (const uri of uris) {
        const listing = resources.resources.find((resource) => resource.uri === uri);
        expect((listing?._meta as { ui?: unknown } | undefined)?.ui).toEqual(expectedPronunciationUi);
        const read = await client.readResource({ uri });
        const content = read.contents[0];
        if (!content || !("text" in content)) throw new Error(`Expected HTML content for ${uri}`);
        expect((content?._meta as { ui?: unknown } | undefined)?.ui).toEqual(expectedPronunciationUi);
        expect(content?.uri).toBe(uri);
        expect(content?.text).toContain(`content="${kind}"`);
        if (latestHtml === undefined) latestHtml = content?.text;
        else expect(content?.text).toBe(latestHtml);
      }
    }
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
