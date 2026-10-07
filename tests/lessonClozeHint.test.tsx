import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withLessonClozeHint } from "../server/services/lessonClozeHint.js";
import { LessonExercisePrompt } from "../web/src/lesson/LessonExercisePrompt.js";
import { getVocabularyItemsByWords } from "../server/services/words.js";

vi.mock("../server/services/words.js", () => ({ getVocabularyItemsByWords: vi.fn() }));
const exercise = {
  mode: "exercise", word: "water", activity_type: "exact_cloze",
  instruction: "填入正确词形。", prompt: "Remember to ___ the plants before leaving.",
  accepted_answers: ["water"], plan: { exercise_id: "frozen" },
};

beforeEach(() => vi.mocked(getVocabularyItemsByWords).mockReset());

describe("Lesson cloze POS hints", () => {
  it("pairs each dictionary POS with its meanings when an old exercise has none", async () => {
    vi.mocked(getVocabularyItemsByWords).mockResolvedValue([{ word: "water", senses: [
      { pos: "n.", definition_cn: "水" }, { pos: "v.", definition_cn: "灌溉" },
    ] }] as any);
    const result = await withLessonClozeHint(exercise);
    expect(result.cloze_hint).toBe("n. 水　v. 灌溉");
    expect(result.prompt).toBe(exercise.prompt);
    expect(result.plan).toBe(exercise.plan);
    expect(result.accepted_answers).toBe(exercise.accepted_answers);
    expect(exercise).not.toHaveProperty("cloze_hint");
    const html = renderToStaticMarkup(<LessonExercisePrompt prompt={result.prompt} hint={result.cloze_hint} activityType={result.activity_type} />);
    expect(html).toContain(exercise.prompt);
    expect(html).toContain("n. 水　v. 灌溉");
    expect(html).not.toContain("water");
  });

  it("reuses frozen grouped meanings without another dictionary read", async () => {
    const result = await withLessonClozeHint({ ...exercise, part_of_speech: "n./v.", meaning_zh: "n. 水　v. 灌溉" });
    expect(result.cloze_hint).toBe("n. 水　v. 灌溉");
    expect(getVocabularyItemsByWords).not.toHaveBeenCalled();
  });

  it("removes English examples and keeps single-POS legacy hints", async () => {
    vi.mocked(getVocabularyItemsByWords).mockResolvedValue([]);
    const result = await withLessonClozeHint({ ...exercise, part_of_speech: "v.", meaning_zh: "灌溉（water plants）" });
    expect(result.cloze_hint).toBe("v. 灌溉");
    expect(result.cloze_hint).not.toContain("water");
  });

  it.each(["cloze", "exact_cloze", "word_recall", "recall", "spelling"])("provides grouped core meanings for %s exercises", async (activity_type) => {
    const result = await withLessonClozeHint({ ...exercise, activity_type, part_of_speech: "n./v.", meaning_zh: "n. 水　v. 灌溉" });
    expect(result.cloze_hint).toBe("n. 水　v. 灌溉");
    expect(result.prompt).toBe(exercise.prompt);
  });

  it("leaves unrelated exercises and consolidation alone", async () => {
    for (const payload of [
      { ...exercise, mode: "explain" }, { ...exercise, activity_type: "listening" },
      { ...exercise, consolidation: true }, { ...exercise, wrapup: true },
    ]) expect(await withLessonClozeHint(payload)).toBe(payload);
    expect(getVocabularyItemsByWords).not.toHaveBeenCalled();
  });
});

describe("Lesson question display", () => {
  const oldPrompt = "打碎（声）；撞车；扣球；走红的作品；打碎；猛烈撞击；打败";
  const coreMeaning = "n. 打碎（声）；撞车；扣球；走红的作品　v. 打碎；猛烈撞击；打败";
  const render = (activityType: unknown, prompt: unknown, hint: unknown) =>
    renderToStaticMarkup(<LessonExercisePrompt activityType={activityType} prompt={prompt} hint={hint} />);

  it.each(["cloze", "exact_cloze", "word_recall", "recall", "spelling", undefined])("replaces legacy Chinese meanings with one POS-grouped question for %s", (type) => {
    expect(render(type, oldPrompt, coreMeaning)).toBe(`<div class="lesson-prompt">${coreMeaning}</div>`);
    expect(render(type, oldPrompt, coreMeaning)).not.toContain("smash");
  });

  it("shows an already labelled Chinese meaning once", () => {
    const meaning = "n. 球形把手；旋钮；疙瘩；小块";
    expect(render("cloze", meaning, meaning)).toBe(`<div class="lesson-prompt">${meaning}</div>`);
  });

  it("preserves English sentence blanks and includes the meaning in the same question block", () => {
    const prompt = "Remember to ___ the plants before leaving.";
    expect(render("exact_cloze", prompt, "n. 水　v. 灌溉")).toBe(`<div class="lesson-prompt">${prompt}\nn. 水　v. 灌溉</div>`);
  });

  it("does not repeat a meaning already included in a sentence prompt", () => {
    const prompt = "Remember to ___ the plants.\nn. 水  v. 灌溉";
    expect(render("cloze", prompt, "n. 水　v. 灌溉")).toBe(`<div class="lesson-prompt">${prompt}</div>`);
  });

  it("preserves Chinese sentence blanks and falls back to the original prompt when no meaning exists", () => {
    expect(render("cloze", "请将水___到花盆里", "v. 灌溉")).toContain("请将水___到花盆里\nv. 灌溉");
    for (const hint of [undefined, null, "", "  "]) {
      expect(render("cloze", oldPrompt, hint)).toBe(`<div class="lesson-prompt">${oldPrompt}</div>`);
    }
  });

  it("keeps the standalone capture attributes on the combined question", () => {
    const html = renderToStaticMarkup(<LessonExercisePrompt prompt={oldPrompt} hint={coreMeaning} className="standalone-reading-width" data-capture-text="true" data-capture-source="lesson_prompt" />);
    expect(html).toContain('class="lesson-prompt standalone-reading-width"');
    expect(html).toContain('data-capture-source="lesson_prompt"');
    expect(html).toContain(coreMeaning);
  });
});
