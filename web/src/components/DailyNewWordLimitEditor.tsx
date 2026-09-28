import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "./Button.js";
import { setDailyNewWordLimitSchema, type SetDailyNewWordLimitInput } from "../../../shared/toolContracts.js";

export const dailyNewWordLimitSaveResultSchema = z.object({
  daily_new_word_limit: z.number().int().min(1).max(200),
  prepared: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
});

export type DailyNewWordLimitSaveResult = z.infer<typeof dailyNewWordLimitSaveResultSchema>;
export type SaveDailyNewWordLimit = (limit: number) => Promise<DailyNewWordLimitSaveResult>;

export function buildDailyNewWordLimitRequest(limit: number): SetDailyNewWordLimitInput {
  return setDailyNewWordLimitSchema.parse({ limit });
}

export function isValidDailyNewWordLimit(value: unknown): value is number {
  return setDailyNewWordLimitSchema.safeParse({ limit: value }).success;
}

export function dailyNewWordLimitFeedback(
  limit: number,
  saved: Pick<DailyNewWordLimitSaveResult, "prepared" | "added">,
): string {
  if (saved.prepared > limit) {
    return `每日目标已设为 ${limit}。今天已经准备 ${saved.prepared} 个，不会移除；从之后的每日队列按 ${limit} 个执行。`;
  }
  if (saved.added > 0) return `每日目标已设为 ${limit}，今天新增 ${saved.added} 个新词。`;
  return `每日目标已设为 ${limit}。`;
}

export function DailyNewWordLimitEditor({
  limit,
  onSave,
  onSaved,
  compact = false,
  disabled = false,
}: {
  limit: number;
  onSave: SaveDailyNewWordLimit;
  onSaved?: (value: { limit: number; prepared: number; added: number }) => void;
  compact?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(limit));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => setDraft(String(limit)), [limit]);

  function updateDraft(next: number): void {
    if (!Number.isFinite(next)) return;
    setDraft(String(Math.max(1, Math.min(200, next))));
    setMessage("");
  }

  async function save(): Promise<void> {
    const parsed = setDailyNewWordLimitSchema.safeParse({ limit: Number(draft) });
    if (!parsed.success) {
      setMessage("请输入 1–200 之间的整数。");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      const saved = dailyNewWordLimitSaveResultSchema.parse(await onSave(parsed.data.limit));
      setMessage(dailyNewWordLimitFeedback(parsed.data.limit, saved));
      onSaved?.({ limit: saved.daily_new_word_limit, prepared: saved.prepared, added: saved.added });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "每日目标未能保存，请重试。");
    } finally {
      setSaving(false);
    }
  }

  const isDisabled = saving || disabled;
  const currentDraft = Number(draft);
  const stepFrom = Number.isFinite(currentDraft) ? currentDraft : limit;

  return <section className={`daily-limit${compact ? " standalone-daily-limit-editor" : ""}`} aria-label="每日新词设置">
    {!compact && <div className="daily-limit-heading"><div><span className="eyebrow">每日新词</span><strong>当前：{limit}</strong></div></div>}
    <div className="daily-limit-input-row">
      <button type="button" aria-label="减少每日新词数量" onClick={() => updateDraft(stepFrom - 1)} disabled={isDisabled || stepFrom <= 1}>−</button>
      <input aria-label="每日新词数量" type="number" min={1} max={200} step={1} inputMode="numeric" value={draft} onChange={(event) => { setDraft(event.target.value); setMessage(""); }} disabled={isDisabled} />
      <button type="button" aria-label="增加每日新词数量" onClick={() => updateDraft(stepFrom + 1)} disabled={isDisabled || stepFrom >= 200}>＋</button>
      <Button className="secondary daily-limit-save" onClick={() => void save()} disabled={isDisabled}>{saving ? "保存中…" : "保存"}</Button>
    </div>
    {compact && <div className="daily-limit-quick-row" aria-label="快捷每日新词目标">
      <span>快捷：</span>
      {[50, 60, 70, 75, 80].map((value) => <button
        className="daily-limit-preset"
        key={value}
        type="button"
        aria-pressed={Number(draft) === value}
        onClick={() => updateDraft(value)}
        disabled={isDisabled}
      >{value}</button>)}
    </div>}
    {message ? <p className="helper-text" role="status">{message}</p> : null}
  </section>;
}
