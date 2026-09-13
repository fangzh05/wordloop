import { getAuthenticatedUserId, getDatabase } from "../db.js";
import { assertDatabaseResult } from "./shared.js";
import { prepareWordList } from "./wordNormalization.js";

export async function saveSentence(input: { sentence: string; extracted_words: string[] }): Promise<Record<string, unknown>> {
  const prepared = input.extracted_words.length > 0 ? prepareWordList(input.extracted_words) : [];
  const { data, error } = await getDatabase().rpc("save_sentence_v1", {
    p_user_id: getAuthenticatedUserId(),
    p_sentence: input.sentence.trim(),
    p_words: prepared,
  });
  assertDatabaseResult(error);
  return data as Record<string, unknown>;
}

