import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaptureInboxPage } from "../web/src/standalone/CaptureInboxPage.js";
import { NoteReviewCard } from "../web/src/standalone/NoteReviewPage.js";
import { StandaloneDashboard, StandaloneReviewQuestion, visibleStandalonePage } from "../web/src/standalone/StandaloneApp.js";
import type { WebApiResponse } from "../web/src/standalone/apiClient.js";

const progress = {
  today: { total: 1, known: 0, uncertain: 0, unknown: 0, completed: 0 },
  review_today: { completed: 0, total: 0, remaining: 0 },
  all_time: { total_words: 1, mastered: 0, learning: 1, error_book: 0 },
  fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 },
  settings: { daily_new_word_limit: 1 },
};

describe("Standalone Notes UI", () => {
  it("keeps Notes open when the server study screen is done and adds a Dashboard entry", () => {
    expect(visibleStandalonePage("notes", "done")).toBe("notes");
    expect(visibleStandalonePage("study", "done")).toBe("dashboard");
    const view: WebApiResponse = {
      screen: "done", session_revision: "rev", state: {}, progress,
    };
    const markup = renderToStaticMarkup(<StandaloneDashboard view={view} busy={false} onContinue={() => undefined} onOpenNotes={() => undefined} />);
    expect(markup).toContain("划词笔记");
  });

  it("offers manual Inbox capture, status filters, and context search", () => {
    const markup = renderToStaticMarkup(<CaptureInboxPage onBack={() => undefined} onUnauthorized={() => undefined} />);
    expect(markup).toContain("手动记录");
    expect(markup).toContain("保存到 Inbox");
    expect(markup).toContain("已收藏");
    expect(markup).toContain("已加入学习");
    expect(markup).toContain("搜索表达、笔记或上下文");
  });

  it("marks visible review prompts as capturable and keeps Notes mobile and desktop layout rules", () => {
    const review = renderToStaticMarkup(<StandaloneReviewQuestion item={{ word: "recur", meaning_zh: "再次发生" }} direction="cn_to_en" />);
    expect(review).toContain("data-capture-text=\"true\"");
    const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(css.match(/\.standalone-layout\[data-page="notes"\] \.standalone-sidebar/g)).toHaveLength(2);
  });

  it("keeps the note and source context out of the front until the learner reveals it", () => {
    const item = {
      note_id: "00000000-0000-4000-8000-000000000002",
      selected_text: "in light of",
      note: "表示考虑到某个事实。",
      note_updated_at: "2026-10-02T00:00:00.000Z",
      due: "2026-10-02T00:00:00.000Z",
      revision: 0,
      latest_occurrence: {
        context_text: "In light of the evidence, we changed course.",
        source_type: "lesson_example",
        source_title: "Lesson",
        source_url: null,
        captured_at: "2026-10-01T00:00:00.000Z",
      },
    };
    const front = renderToStaticMarkup(<NoteReviewCard item={item} revealed={false} onReveal={() => undefined} onRate={() => undefined} />);
    const revealed = renderToStaticMarkup(<NoteReviewCard item={item} revealed onReveal={() => undefined} onRate={() => undefined} />);
    expect(front).toContain("in light of");
    expect(front).not.toContain("表示考虑到某个事实");
    expect(front).not.toContain("In light of the evidence");
    expect(revealed).toContain("表示考虑到某个事实");
    expect(revealed).toContain("In light of the evidence");
    expect(revealed).toContain(">Again<");
    expect(revealed).toContain(">Good<");
  });
});
