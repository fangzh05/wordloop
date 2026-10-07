import { formatMeaningByPartOfSpeech, meaningIncludesPartOfSpeech } from "../../shared/lexicalDisplay.js";
import { getVocabularyItemsByWords } from "./words.js";

const clozeTypes = new Set(["cloze", "exact_cloze"]);

/** Display-only metadata: keep the frozen question, answer and plan intact. */
export async function withLessonClozeHint(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload.mode !== "exercise" || payload.consolidation === true || payload.wrapup === true
    || !clozeTypes.has(String(payload.activity_type))) return payload;
  let meaning = typeof payload.meaning_zh === "string" ? payload.meaning_zh : "";
  const pos = typeof payload.part_of_speech === "string" ? payload.part_of_speech.trim() : "";
  if (!meaningIncludesPartOfSpeech(meaning, pos) && typeof payload.word === "string") {
    const [item] = await getVocabularyItemsByWords([payload.word]);
    const dictionaryMeaning = formatMeaningByPartOfSpeech(item?.senses);
    if (dictionaryMeaning) meaning = dictionaryMeaning;
    if (pos && !pos.includes("/") && meaning && !meaningIncludesPartOfSpeech(meaning, pos)) meaning = `${pos} ${meaning}`;
  }
  // Dictionary definitions can contain English examples. Only Chinese meanings
  // and standard POS abbreviations are safe before the answer is revealed.
  const hint = meaning.replace(/[A-Za-z]+(?:[.'’/-][A-Za-z]+)*\.?/g, (token) =>
    /^(?:n|v|vt|vi|adj|adv|prep|pron|conj|det|art|num|aux|modal|interj)\.$/i.test(token) ? token : ""
  ).replace(/[（(]\s*[)）]/g, "").trim();
  return /\p{Script=Han}/u.test(hint) ? { ...payload, cloze_hint: hint } : payload;
}
