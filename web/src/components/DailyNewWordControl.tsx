import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "./Button.js";
import { callServerTool, structuredContentOf } from "../mcpBridge.js";

const limitSchema = z.object({ daily_new_word_limit: z.number().int().min(1).max(200) });
const preparedSchema = z.object({ date: z.string(), prepared: z.number().int().nonnegative(), added: z.number().int().nonnegative(), limit: z.number().int().min(1).max(200) });

export function DailyNewWordControl({
  limit,
  todayPrepared = 0,
  onSaved,
}: {
  limit: number;
  todayPrepared?: number;
  onSaved?: (value: { limit: number; prepared: number; added: number }) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(limit));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => setDraft(String(limit)), [limit]);

  function updateDraft(next: number): void {
    setDraft(String(Math.max(1, Math.min(200, next))));
    setMessage("");
  }

  async function save(): Promise<void> {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 1 || next > 200) {
      setMessage("请输入 1–200 之间的整数。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const limitResult = await callServerTool("set_daily_new_word_limit", { limit: next });
      const storedLimit = limitSchema.safeParse(structuredContentOf(limitResult));
      if (limitResult.isError || !storedLimit.success) throw new Error("每日新词数量未能保存，请重试。");

      const prepareResult = await callServerTool("prepare_daily_new_words", {});
      const prepared = preparedSchema.safeParse(structuredContentOf(prepareResult));
      if (prepareResult.isError || !prepared.success) throw new Error("数量已保存，但今日新词暂时无法补充。");

      const result = prepared.data;
      if (todayPrepared > next) {
        setMessage(`每日新词已设为 ${next}。今天已经准备 ${todayPrepared} 个，不会删除；之后按 ${next} 个执行。`);
      } else if (result.added > 0) {
        setMessage(`每日新词已设为 ${next}，今天新增 ${result.added} 个。`);
      } else {
        setMessage(`每日新词已设为 ${next}。`);
      }
      onSaved?.({ limit: storedLimit.data.daily_new_word_limit, prepared: result.prepared, added: result.added });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "每日新词数量未能保存，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return <section className="daily-limit" aria-label="每日新词设置">
    <div className="daily-limit-heading"><div><span className="eyebrow">每日新词</span><strong>当前：{limit}</strong></div></div>
    <div className="daily-limit-input-row">
      <button type="button" aria-label="减少每日新词数量" onClick={() => updateDraft(Number(draft || limit) - 1)} disabled={saving || Number(draft) <= 1}>−</button>
      <input aria-label="每日新词数量" type="number" min={1} max={200} inputMode="numeric" value={draft} onChange={(event) => { setDraft(event.target.value); setMessage(""); }} disabled={saving} />
      <button type="button" aria-label="增加每日新词数量" onClick={() => updateDraft(Number(draft || limit) + 1)} disabled={saving || Number(draft) >= 200}>＋</button>
      <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
    </div>
    <div className="daily-limit-presets" aria-label="快捷数量">
      {[20, 30, 50, 80].map((value) => <button type="button" key={value} onClick={() => updateDraft(value)} disabled={saving}>{value}</button>)}
    </div>
    {message ? <p className="helper-text" role="status">{message}</p> : null}
  </section>;
}
