const recallTypes = new Set(["word_recall", "recall", "spelling"]);

/** Put the enriched core meaning in the question itself for Chinese recall prompts. */
export function lessonPromptWithMeaning(activityType: unknown, prompt: unknown, hint: unknown): string {
  const promptText = typeof prompt === "string" ? prompt : "";
  const hintText = typeof hint === "string" ? hint.trim() : "";
  return recallTypes.has(String(activityType)) && hintText ? hintText : promptText;
}

export function LessonClozeHint({ hint, prompt, activityType }: { hint: unknown; prompt?: unknown; activityType?: unknown }) {
  const text = typeof hint === "string" ? hint.trim() : "";
  const visiblePrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (recallTypes.has(String(activityType))) return null;
  const normalizedHint = text.normalize("NFKC").replace(/\s+/g, "");
  const normalizedPrompt = visiblePrompt.normalize("NFKC").replace(/\s+/g, "");
  return text && !normalizedPrompt.includes(normalizedHint)
    ? <p className="answer-hint lesson-cloze-hint" aria-label="词性与释义">{text}</p>
    : null;
}
