import type { ActiveErrorLayer, UserWordRow } from "../types.js";

export function dateInTimeZone(timeZone = "Asia/Shanghai", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addCalendarDays(date: string, days: number): string {
  const value = new Date(date + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localDateStart(date: string, timeZone: string): string {
  const targetWallTime = Date.parse(date + "T00:00:00.000Z");
  let candidate = targetWallTime;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Map(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const localWallTime = Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")),
      Number(parts.get("minute")),
      Number(parts.get("second")),
    );
    const correction = targetWallTime - localWallTime;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

export function localDateRange(date: string, timeZone: string): { start: string; end: string } {
  return {
    start: localDateStart(date, timeZone),
    end: localDateStart(addCalendarDays(date, 1), timeZone),
  };
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

