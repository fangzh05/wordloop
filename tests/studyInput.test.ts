import { describe, expect, it } from "vitest";
import { shouldSubmitMultiline, shouldSubmitSingleLine } from "../web/src/standalone/studyInput.js";

const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false } as const;

describe("study input keyboard behavior", () => {
  it("does not submit a single-line answer while an IME composition is active", () => {
    expect(shouldSubmitSingleLine({ ...enter, isComposing: true })).toBe(false);
    expect(shouldSubmitSingleLine(enter)).toBe(true);
    expect(shouldSubmitSingleLine({ ...enter, shiftKey: true })).toBe(false);
  });

  it("keeps Enter for multiline input and submits only with Command or Control plus Enter", () => {
    expect(shouldSubmitMultiline(enter)).toBe(false);
    expect(shouldSubmitMultiline({ ...enter, ctrlKey: true })).toBe(true);
    expect(shouldSubmitMultiline({ ...enter, metaKey: true })).toBe(true);
    expect(shouldSubmitMultiline({ ...enter, ctrlKey: true, isComposing: true })).toBe(false);
  });
});
