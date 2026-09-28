import { describe, expect, it } from "vitest";
import { deriveLessonProfile } from "../server/services/lessonProfile.js";

describe("server-owned Lesson profile", () => {
  it("uses quick_recall for uncertain words without relearn or active errors", () => {
    expect(deriveLessonProfile({ status: "uncertain", is_relearn: false, error_layers: [] }))
      .toEqual({ lesson_profile: "quick_recall", error_focus: null });
  });

  it("uses reinforce for unknown words without relearn or active errors", () => {
    expect(deriveLessonProfile({ status: "unknown", is_relearn: false, error_layers: [] }))
      .toEqual({ lesson_profile: "reinforce", error_focus: null });
  });

  it("keeps an explicitly queued Review relearn targeted after the live status changes", () => {
    expect(deriveLessonProfile({ status: "known", is_relearn: true, error_layers: [] }))
      .toEqual({ lesson_profile: "targeted_relearn", error_focus: null });
  });

  it("uses the first current active error layer as the targeted focus", () => {
    expect(deriveLessonProfile({ status: "uncertain", is_relearn: false, error_layers: ["spelling"] }))
      .toEqual({ lesson_profile: "targeted_relearn", error_focus: "spelling" });
  });
});
