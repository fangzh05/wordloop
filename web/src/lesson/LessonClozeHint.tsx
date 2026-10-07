export function LessonClozeHint({ hint, prompt }: { hint: unknown; prompt?: unknown }) {
  const text = typeof hint === "string" ? hint.trim() : "";
  const visiblePrompt = typeof prompt === "string" ? prompt.trim() : "";
  return text && !visiblePrompt.includes(text)
    ? <p className="answer-hint lesson-cloze-hint" aria-label="词性与释义">{text}</p>
    : null;
}
