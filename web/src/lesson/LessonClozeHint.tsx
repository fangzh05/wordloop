export function LessonClozeHint({ hint }: { hint: unknown }) {
  return typeof hint === "string" && hint.trim()
    ? <p className="answer-hint lesson-cloze-hint" aria-label="词性与释义">{hint}</p>
    : null;
}
