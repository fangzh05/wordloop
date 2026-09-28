import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEACHING_PROMPT } from "../server/teachingPrompt.js";
import { LESSON_GENERATION_PROMPT } from "../server/services/deepseekPrompts.js";

describe("exam-focused teaching policy", () => {
  it("sets the requested exam goals, concise examples and round sentence length", () => {
    expect(TEACHING_PROMPT).toContain("考研英语一 80+");
    expect(TEACHING_PROMPT).toContain("IELTS 7.5");
    expect(TEACHING_PROMPT).toContain("通用正式语境");
    expect(TEACHING_PROMPT).toContain("15–25 个英文词");
    expect(TEACHING_PROMPT).toContain("25–40 词");
    expect(TEACHING_PROMPT).toContain("For exact_cloze:");
    expect(TEACHING_PROMPT).toContain("Never put an English answer blank inside a Chinese sentence.");
    expect(TEACHING_PROMPT).toContain("use activity_type=translation_cn_to_en");
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

  it("requests every dictionary part of speech and Chinese translations for lexical entries", () => {
    expect(TEACHING_PROMPT).toContain("输入中列出的全部词性");
    expect(TEACHING_PROMPT).toContain("collocations 和 derivations 中的每个条目都要同时包含英文表达与简体中文释义");
    expect(LESSON_GENERATION_PROMPT).toContain("词性覆盖输入给出的全部词性");
    expect(LESSON_GENERATION_PROMPT).toContain("每个搭配和派生都要在同一字符串中同时给出英文和简体中文释义");
  });
});
