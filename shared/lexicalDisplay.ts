export interface PartOfSpeechSense {
  pos?: string | null;
  definition_cn?: string | null;
}

/** Keep every distinct dictionary part-of-speech label in its source order. */
export function formatPartOfSpeech(senses: readonly PartOfSpeechSense[] | null | undefined): string | undefined {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const sense of senses ?? []) {
    const label = sense.pos?.trim();
    if (!label) continue;
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels.length > 0 ? labels.join("/") : undefined;
}

/** Pair each Chinese definition with its dictionary part of speech. */
export function formatMeaningByPartOfSpeech(senses: readonly PartOfSpeechSense[] | null | undefined): string {
  const entries: Array<{ label: string; meanings: string[] }> = [];
  const byPartOfSpeech = new Map<string, { label: string; meanings: string[] }>();
  const unlabelled: string[] = [];
  for (const sense of senses ?? []) {
    const meaning = sense.definition_cn?.trim();
    if (!meaning) continue;
    const label = sense.pos?.trim() ?? "";
    if (!label) {
      if (!unlabelled.includes(meaning)) unlabelled.push(meaning);
      continue;
    }
    const key = label.toLocaleLowerCase();
    let entry = byPartOfSpeech.get(key);
    if (!entry) {
      entry = { label, meanings: [] };
      byPartOfSpeech.set(key, entry);
      entries.push(entry);
    }
    if (!entry.meanings.includes(meaning)) entry.meanings.push(meaning);
  }
  return [
    ...entries.map(({ label, meanings }) => `${label} ${meanings.join("；")}`),
    ...unlabelled,
  ].join("　");
}

/** Avoid repeating the part-of-speech chip when meanings already label each sense. */
export function meaningIncludesPartOfSpeech(meaning: string, partOfSpeech?: string | null): boolean {
  const labels = (partOfSpeech ?? "").split("/").map((label) => label.trim()).filter(Boolean);
  return labels.length > 0 && labels.every((label) => meaning.includes(`${label} `));
}
