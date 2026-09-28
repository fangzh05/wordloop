import { callServerTool, structuredContentOf } from "../mcpBridge.js";
import {
  DailyNewWordLimitEditor,
  buildDailyNewWordLimitRequest,
  dailyNewWordLimitSaveResultSchema,
} from "./DailyNewWordLimitEditor.js";
import type { DailyNewWordLimitSaveResult } from "./DailyNewWordLimitEditor.js";

export { buildDailyNewWordLimitRequest } from "./DailyNewWordLimitEditor.js";

async function saveDailyNewWordLimitWithMcp(limit: number): Promise<DailyNewWordLimitSaveResult> {
  const result = await callServerTool("set_daily_new_word_limit", buildDailyNewWordLimitRequest(limit));
  const saved = dailyNewWordLimitSaveResultSchema.safeParse(structuredContentOf(result));
  if (result.isError || !saved.success) throw new Error("每日目标未能保存，请重试。");
  return saved.data;
}

export function DailyNewWordControl({
  limit,
  onSaved,
}: {
  limit: number;
  todayPrepared?: number;
  onSaved?: (value: { limit: number; prepared: number; added: number }) => void;
}): React.JSX.Element {
  return <DailyNewWordLimitEditor limit={limit} onSave={saveDailyNewWordLimitWithMcp} onSaved={onSaved} />;
}
