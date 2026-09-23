import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEACHING_PROMPT } from "../server/teachingPrompt.js";

describe("exam-focused teaching policy", () => {
  it("sets the requested exam goals, concise examples and round sentence length", () => {
    expect(TEACHING_PROMPT).toContain("考研英语一 80+");
    expect(TEACHING_PROMPT).toContain("IELTS 7.5");
    expect(TEACHING_PROMPT).toContain("通用正式语境");
    expect(TEACHING_PROMPT).toContain("15–25 个英文词");
    expect(TEACHING_PROMPT).toContain("25–40 词");
    expect(TEACHING_PROMPT).not.toContain("例句和练习尽量使用医学、肿瘤免疫、RNA-seq");
    expect(TEACHING_PROMPT).not.toContain("每完成 2 轮做一次 30–40 词的连贯听写");
  });

  it("keeps lesson derivations and existing explain fields", () => {
    const source = readFileSync(new URL("../server/tools/renderWidgets.ts", import.meta.url), "utf8");
    expect(source).toMatch(/derivations:\s*z\.array/);
    expect(source).toMatch(/collocations:\s*z\.array/);
    expect(source).toMatch(/example_en:\s*z\.string/);
    expect(source).toMatch(/note:\s*z\.string/);
    expect(TEACHING_PROMPT).toContain("2–3 个常见同根派生词");
  });
});
