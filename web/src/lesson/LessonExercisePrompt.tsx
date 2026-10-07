import type { HTMLAttributes } from "react";

const recallTypes = new Set(["word_recall", "recall", "spelling"]);

/** Legacy cloze questions can also consist entirely of Chinese core meanings. */
export function lessonPromptWithMeaning(activityType: unknown, prompt: unknown, hint: unknown): string {
  const promptText = typeof prompt === "string" ? prompt : "";
  const hintText = typeof hint === "string" ? hint.trim() : "";
  if (!hintText) return promptText;
  const withoutPos = promptText.replace(/\b(?:n|v|vt|vi|adj|adv|prep|pron|conj|det|art|num|aux|modal|interj)\.\s*/gi, "");
  const meaningOnly = /\p{Script=Han}/u.test(withoutPos) && !/[A-Za-z_□＿]/u.test(withoutPos);
  if (recallTypes.has(String(activityType)) || meaningOnly || !promptText.trim()) return hintText;
  const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
  return normalize(promptText).includes(normalize(hintText)) ? promptText : `${promptText}\n${hintText}`;
}

interface LessonExercisePromptProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  prompt: unknown;
  hint?: unknown;
  activityType?: unknown;
}

/** One question block owns both the frozen prompt and its safe core meaning. */
export function LessonExercisePrompt({ prompt, hint, activityType, className = "", ...attributes }: LessonExercisePromptProps) {
  return <div {...attributes} className={`lesson-prompt ${className}`.trim()}>{lessonPromptWithMeaning(activityType, prompt, hint)}</div>;
}
