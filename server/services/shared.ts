import type { ActiveErrorLayer, UserWordRow } from "../types.js";

export function dateInTimeZone(timeZone = "Asia/Shanghai", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function errorLayers(row: Pick<UserWordRow,
  "meaning_error" | "collocation_error" | "grammar_error" | "pronunciation_error" | "spelling_error"
>): ActiveErrorLayer[] {
  const layers: ActiveErrorLayer[] = [];
  if (row.meaning_error) layers.push("meaning");
  if (row.collocation_error) layers.push("collocation");
  if (row.grammar_error) layers.push("grammar");
  if (row.pronunciation_error) layers.push("pronunciation");
  if (row.spelling_error) layers.push("spelling");
  return layers;
}

export function assertDatabaseResult(error: { message: string } | null): void {
  if (error) throw new Error(`Database operation failed: ${error.message}`);
}

