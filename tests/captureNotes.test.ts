import { describe, expect, it } from "vitest";
import {
  inferCaptureSelectionType,
  normalizeCaptureText,
} from "../server/services/captureNotes.js";

describe("capture notes normalization", () => {
  it("normalizes case and repeated whitespace without discarding phrase structure", () => {
    expect(normalizeCaptureText("  Reconcile   A With B  ")).toBe("reconcile a with b");
    expect(normalizeCaptureText("BE   ATTRIBUTED\nTO")).toBe("be attributed to");
  });

  it("classifies short captures without forcing long sentences into word cards", () => {
    expect(inferCaptureSelectionType("opaque")).toBe("word");
    expect(inferCaptureSelectionType("be attributed to")).toBe("phrase");
    expect(inferCaptureSelectionType("Although the treatment was effective, the adverse effects still required close monitoring."))
      .toBe("sentence");
  });
});
