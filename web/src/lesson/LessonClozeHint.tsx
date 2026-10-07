const recallTypes = new Set(["word_recall", "recall", "spelling"]);
const partOfSpeechLabel = /(?:^|[\s　])(?:n|v|vt|vi|adj|adv|prep|pron|conj|det|art|num|aux|modal|interj)\.(?=\s*\p{Script=Han})/iu;

export function LessonClozeHint({ hint, prompt, activityType }: { hint: unknown; prompt?: unknown; activityType?: unknown }) {
  const text = typeof hint === "string" ? hint.trim() : "";
  const visiblePrompt = typeof prompt === "string" ? prompt.trim() : "";
  const normalizedHint = text.normalize("NFKC").replace(/\s+/g, "");
  const normalizedPrompt = visiblePrompt.normalize("NFKC").replace(/\s+/g, "");
  const promptAlreadyHasPartOfSpeech = recallTypes.has(String(activityType)) && partOfSpeechLabel.test(visiblePrompt);
  return text && !normalizedPrompt.includes(normalizedHint) && !promptAlreadyHasPartOfSpeech
    ? <p className="answer-hint lesson-cloze-hint" aria-label="词性与释义">{text}</p>
    : null;
}
