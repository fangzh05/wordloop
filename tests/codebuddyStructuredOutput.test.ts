import { describe, expect, it } from "vitest";
import { parseCliResult } from "../scripts/import-anki-lesson-cache.js";

describe("CodeBuddy CLI structured output parser", () => {
  it("unwraps the restricted StructuredOutput event and keeps exact token usage", () => {
    const events = [
      { type: "function_call", name: "StructuredOutput", arguments: JSON.stringify({ data: { note: "usage note", exercise: { activity_type: "word_recall" } } }) },
      { type: "function_call_result", name: "StructuredOutput", status: "completed", output: "ok" },
      { type: "result", result: "", usage: { input_tokens: 913, output_tokens: 74 } },
    ];

    expect(parseCliResult(JSON.stringify(events))).toEqual({
      payload: { note: "usage note", exercise: { activity_type: "word_recall" } },
      inputTokens: 913,
      outputTokens: 74,
    });
  });

  it("rejects plain text or an incomplete structured-output call", () => {
    expect(() => parseCliResult("not JSON" )).toThrow("CODEBUDDY_INVALID_JSON");
    expect(() => parseCliResult(JSON.stringify([
      { type: "function_call", name: "StructuredOutput", arguments: "{}" },
      { type: "result", result: "" },
    ]))).toThrow("CODEBUDDY_INVALID_JSON");
  });
});
