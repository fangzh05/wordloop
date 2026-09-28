import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandalonePretestAnswerReveal } from "../web/src/standalone/StandaloneApp.js";

function renderResult(source: string, status: string): string {
  return renderToStaticMarkup(<StandalonePretestAnswerReveal
    source={source}
    word="alleviate"
    answer="aleviate"
    status={status}
    errorLayer="spelling"
    markedFamiliar={false}
    busy={false}
    onContinue={() => undefined}
    onMarkFamiliar={() => undefined}
  />);
}

describe("Standalone Pretest answer reveal", () => {
  it("reveals the target and offers familiar correction for a new-word spelling near miss", () => {
    const markup = renderResult("new_word", "uncertain");

    expect(markup).toContain("你的答案：<strong>aleviate</strong>");
    expect(markup).toContain("正确答案：<strong>alleviate</strong>");
    expect(markup).toContain("拼写接近，但仍有拼写错误。");
    expect(markup).toContain("我本来会这个词");
    expect(markup).toContain("未来仍可能正常复习");
  });

  it("does not offer a familiar action for a known result or non-new-word Pretest", () => {
    expect(renderResult("new_word", "known")).not.toContain("我本来会这个词");
    expect(renderResult("review", "uncertain")).not.toContain("我本来会这个词");
  });
});
