import { z } from "zod";

const wordPattern = /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*)?$/u;

export const wordInputSchema = z.string().transform((value) => value.trim()).pipe(
  z.string().min(1).max(100).refine((value) => wordPattern.test(value), {
    message: "Words may contain letters, apostrophes, hyphens, and at most one internal space.",
  }),
);

export function normalizeWord(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export interface NormalizedWord {
  display: string;
  normalized: string;
  position: number;
}

export function prepareWordList(values: string[]): NormalizedWord[] {
  const seen = new Set<string>();
  const output: NormalizedWord[] = [];
  for (const raw of values) {
    if (!raw.trim()) continue;
    const display = wordInputSchema.parse(raw);
    const normalized = normalizeWord(display);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push({ display, normalized, position: output.length });
  }
  if (output.length === 0) throw new Error("No valid words were provided.");
  if (output.length > 500) throw new Error("A single import is limited to 500 words.");
  return output;
}

export function parsePastedWords(value: string): string[] {
  return value.split(/[\s,;，；]+/u).map((word) => word.trim()).filter(Boolean);
}

