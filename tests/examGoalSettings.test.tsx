import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSheet } from "../web/src/standalone/AppShell.js";
import { ExamBookProvider } from "../web/src/standalone/components/ExamBookSelector.js";

describe("exam goal settings", () => {
  it("offers book selection directly in Settings when no target book is selected", () => {
    const markup = renderToStaticMarkup(
      <ExamBookProvider tokenKey={null}>
        <SettingsSheet
          open
          onClose={() => undefined}
          appearance="system"
          onAppearanceChange={() => undefined}
          dailyLimit={20}
          busy={false}
          onSaveDailyTimeBudget={async () => undefined}
          onSaveExamGoal={async () => undefined}
        />
      </ExamBookProvider>,
    );

    expect(markup).toContain("先选择目标考试词书，再设置考试日期和覆盖量。");
    expect(markup).toContain('aria-label="当前学习词书"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain(">选择</button>");
    expect(markup).toMatch(/id="exam-deadline" type="date"[^>]*disabled=""/);
  });
});
