import { z } from "zod";
import { normalizeWord } from "../../services/wordNormalization.js";
import type { ShanbayBook, ShanbaySourceState, ShanbayWord } from "./types.js";

const senseSchema = z.object({ pos: z.string().optional(), definition_cn: z.string().optional() }).passthrough();
const lexicalSchema = z.object({
  word: z.string().trim().min(1),
  senses: z.array(senseSchema).optional(),
  sound: z.object({ ipa_us: z.string().optional(), ipa_uk: z.string().optional() }).passthrough().optional(),
}).passthrough();
const itemSchema = z.object({
  vocabulary: lexicalSchema.optional(),
  vocab_with_senses: lexicalSchema.optional(),
}).passthrough();

export function mapShanbayWord(value: unknown, state: ShanbaySourceState, position: number): ShanbayWord {
  const parsed = itemSchema.safeParse(value);
  const lexical = parsed.success ? parsed.data.vocabulary ?? parsed.data.vocab_with_senses : undefined;
  if (!lexical) throw new Error("Shanbay API format changed.");
  const normalized = normalizeWord(lexical.word);
  return {
    normalized, display: lexical.word.trim(), ipa_us: lexical.sound?.ipa_us?.trim() || null,
    ipa_uk: lexical.sound?.ipa_uk?.trim() || null,
    senses: (lexical.senses ?? []).flatMap((sense) => (sense.definition_cn ?? "")
      .split(/<br\s*\/?\s*>/iu)
      .map((definition) => definition.replace(/<[^>]+>/gu, "").trim())
      .filter(Boolean)
      .map((definition_cn) => ({ pos: sense.pos?.trim() ?? "", definition_cn }))),
    source_state: state, position,
  };
}

export function mapCurrentBook(value: unknown): ShanbayBook {
  const payload = z.object({
    materialbook_id: z.union([z.string(), z.number()]),
    name: z.string().optional(), title: z.string().optional(),
    materialbook: z.object({ name: z.string().optional(), title: z.string().optional() }).passthrough().optional(),
  }).passthrough().safeParse(value);
  if (!payload.success) throw new Error("No active Shanbay word book found.");
  return {
    id: String(payload.data.materialbook_id),
    name: payload.data.materialbook?.name ?? payload.data.materialbook?.title ?? payload.data.name ?? payload.data.title ?? "Current Shanbay book",
    is_current: true,
  };
}

export function dedupeShanbayWords(words: ShanbayWord[]): ShanbayWord[] {
  const seen = new Map<string, ShanbayWord>();
  for (const word of words) if (!seen.has(word.normalized)) seen.set(word.normalized, word);
  return [...seen.values()];
}
