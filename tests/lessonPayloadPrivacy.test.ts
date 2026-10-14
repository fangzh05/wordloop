import { describe, expect, it } from "vitest";
import { lessonWidgetResponsePayload } from "../server/tools/renderWidgets.js";

describe("Lesson Widget response privacy", () => {
  it("removes fixed answers and first-error references from the MCP payload", () => {
    const safe = lessonWidgetResponsePayload({
      mode: "feedback",
      accepted_answers: ["allocate resources"],
      exercise: { activity_type: "exact_cloze", prompt: "Use ___ here.", accepted_answers: ["allocate"] },
      feedback: {
        is_correct: false,
        reveal_answer: false,
        reference_answer: "allocate resources",
        target_word_results: [{ word: "allocate", outcome: "incorrect", reference_expression: "allocate resources" }],
      },
    });

    expect(safe).not.toHaveProperty("accepted_answers");
    const safePayload = safe as Record<string, any>;
    expect(safePayload.exercise).not.toHaveProperty("accepted_answers");
    expect(safePayload.feedback).not.toHaveProperty("reference_answer");
    expect(safePayload.feedback.target_word_results[0]).not.toHaveProperty("reference_expression");
  });

  it("reveals the top-level reference only after the saved feedback says the answer was revealed", () => {
    const safe = lessonWidgetResponsePayload({
      mode: "feedback",
      feedback: { is_correct: false, reveal_answer: true, reference_answer: "allocate resources" },
    });
    expect((safe as Record<string, any>).feedback.reference_answer).toBe("allocate resources");
  });
});

it('keeps the private frozen word server-side when serializing a lesson plan',()=>{
 const original={mode:'exercise',plan:{private_source_word:'fixture',private_source_book_id:'ielts-zhenjing',target_sense:'SYNTHETIC PRIVATE SENSE'}};
 const safe=lessonWidgetResponsePayload(original);expect(safe.plan).not.toHaveProperty('private_source_word');expect(original.plan.private_source_word).toBe('fixture');
});
