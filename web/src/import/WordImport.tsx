import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { DailyNewWordControl } from "../components/DailyNewWordControl.js";
import { ArrowIcon } from "../components/Icons.js";
import { callServerTool, sendUserMessage, structuredContentOf, updateModelContext } from "../mcpBridge.js";

const bookSchema = z.object({ id: z.string(), name: z.string(), is_current: z.boolean() });
const previewSchema = z.object({ book: bookSchema, unlearned: z.number(), learning: z.number(), simple_learned: z.number(), estimated_unique_total: z.number() });
const migrationSchema = z.object({ books: z.number(), book: bookSchema, unique: z.number(), new: z.number(), existing: z.number() });
const manualSchema = z.object({ date: z.string(), source: z.string(), total: z.number(), new: z.number(), existing: z.number() });
const contextSettingsSchema = z.object({ settings: z.object({ daily_new_word_limit: z.number().int().min(1).max(200) }) });
const preparedSchema = z.object({ prepared: z.number().int().nonnegative(), added: z.number().int().nonnegative(), limit: z.number().int().min(1).max(200) });
const importCursorSchema = z.object({ state: z.enum(["unlearned", "learning", "simple_learned"]), page: z.number().int().min(1) });
const migrationChunkSchema = z.object({
  books: z.literal(1), book: bookSchema, unique: z.number(), new: z.number(), existing: z.number(),
  processed: z.number(), state: z.string(), page: z.number(), pages: z.number(),
  state_total: z.number().nullable(), complete: z.boolean(), next_cursor: importCursorSchema.nullable(),
});
const checkpointSchema = z.object({
  cursor: importCursorSchema.nullable(), processed: z.number(), unique: z.number(), new: z.number(), existing: z.number(),
});

type ImportCheckpoint = z.infer<typeof checkpointSchema>;

function checkpointKey(bookId: string): string { return `wordloop:shanbay-import:${bookId}`; }

function loadCheckpoint(bookId: string): ImportCheckpoint | null {
  try {
    const raw = window.localStorage.getItem(checkpointKey(bookId));
    if (!raw) return null;
    const parsed = checkpointSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function saveCheckpoint(bookId: string, value: ImportCheckpoint): void {
  try { window.localStorage.setItem(checkpointKey(bookId), JSON.stringify(value)); } catch { /* storage is optional */ }
}

function clearCheckpoint(bookId: string): void {
  try { window.localStorage.removeItem(checkpointKey(bookId)); } catch { /* storage is optional */ }
}

function parseWords(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\s,;，；]+/u).map((value) => value.trim()).filter((value) => {
    const normalized = value.toLocaleLowerCase("en-US");
    if (!value || seen.has(normalized)) return false;
    seen.add(normalized); return true;
  });
}

function userFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Shanbay login expired")) return "扇贝登录已失效，请重新配置服务器端登录信息。";
  if (message.includes("Shanbay unavailable")) return "扇贝暂时不可用，请稍后重试。";
  if (message.includes("Unable to decode Shanbay")) return "无法解析扇贝返回的数据，请稍后重试。";
  if (message.includes("Shanbay API format changed")) return "扇贝接口格式发生变化，暂时无法读取词书。";
  return message || fallback;
}

export function WordImport(): React.JSX.Element {
  const [book, setBook] = useState<z.infer<typeof bookSchema> | null>(null);
  const [preview, setPreview] = useState<z.infer<typeof previewSchema> | null>(null);
  const [migration, setMigration] = useState<z.infer<typeof migrationSchema> | null>(null);
  const [bookId, setBookId] = useState("");
  const [manual, setManual] = useState("");
  const [status, setStatus] = useState<"loading" | "idle" | "preview" | "import" | "done" | "error">("loading");
  const [message, setMessage] = useState("");
  const [importProgress, setImportProgress] = useState<{ processed: number; total: number | null; state: string } | null>(null);
  const [dailyLimit, setDailyLimit] = useState(50);
  const [todayPrepared, setTodayPrepared] = useState(0);
  const [starting, setStarting] = useState(false);
  const words = useMemo(() => parseWords(manual), [manual]);

  async function refresh(): Promise<void> {
    setStatus("loading"); setMessage(""); setPreview(null);
    try {
      const result = await callServerTool("get_current_shanbay_book", {});
      const parsed = bookSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("Shanbay 登录已失效或尚未配置。");
      setBook(parsed.data); setBookId(parsed.data.id); setStatus("idle");
    } catch (error) { setStatus("error"); setMessage(userFacingError(error, "无法读取扇贝词书。")); }
  }

  async function loadDailySetting(): Promise<void> {
    try {
      const result = await callServerTool("get_learning_context", {});
      const parsed = contextSettingsSchema.safeParse(structuredContentOf(result));
      if (!result.isError && parsed.success) setDailyLimit(parsed.data.settings.daily_new_word_limit);
    } catch {
      // The default 50 remains a usable fallback while a host reconnects.
    }
  }

  useEffect(() => { void refresh(); void loadDailySetting(); }, []);

  async function previewBook(): Promise<void> {
    if (!bookId.trim()) return;
    setStatus("preview"); setMessage("");
    try {
      const result = await callServerTool("preview_shanbay_book", { book_id: bookId.trim() });
      const parsed = previewSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("无法预览这本词书。");
      setPreview(parsed.data); setStatus("idle");
    } catch (error) { setStatus("error"); setMessage(userFacingError(error, "预览失败。")); }
  }

  async function importBook(): Promise<void> {
    const selectedBookId = bookId.trim();
    if (!selectedBookId) return;
    setStatus("import"); setMessage("");
    const checkpoint = loadCheckpoint(selectedBookId);
    const aggregate = {
      unique: checkpoint?.unique ?? 0,
      new: checkpoint?.new ?? 0,
      existing: checkpoint?.existing ?? 0,
      processed: checkpoint?.processed ?? 0,
    };
    let cursor = checkpoint?.cursor ?? undefined;
    const sourceTotal = preview ? preview.unlearned + preview.learning + preview.simple_learned : null;
    setImportProgress({ processed: aggregate.processed, total: sourceTotal, state: cursor?.state ?? "unlearned" });
    try {
      // Each call reads at most eight Shanbay pages and writes immediately.
      // If the host interrupts the widget, the cursor remains locally and the
      // next click resumes from the last acknowledged chunk.
      for (let chunk = 0; chunk < 2_000; chunk += 1) {
        const result = await callServerTool("import_shanbay_book", {
          book_id: selectedBookId,
          ...(cursor ? { cursor } : {}),
        });
        const parsed = migrationChunkSchema.safeParse(structuredContentOf(result));
        if (result.isError || !parsed.success) throw new Error("词书迁移失败，已保留当前进度。再次点击可继续。");
        aggregate.unique += parsed.data.unique;
        aggregate.new += parsed.data.new;
        aggregate.existing += parsed.data.existing;
        aggregate.processed += parsed.data.processed;
        cursor = parsed.data.next_cursor ?? undefined;
        setImportProgress({ processed: aggregate.processed, total: sourceTotal, state: parsed.data.state });
        saveCheckpoint(selectedBookId, { cursor: parsed.data.next_cursor, ...aggregate });
        if (parsed.data.complete) {
          clearCheckpoint(selectedBookId);
          const finalResult = { books: 1, book: parsed.data.book, unique: aggregate.unique, new: aggregate.new, existing: aggregate.existing };
          setMigration(finalResult); setStatus("done");
          await updateModelContext("A Shanbay book was migrated into the independent Wordloop vocabulary pool.", { shanbayMigration: finalResult });
          return;
        }
      }
      throw new Error("导入批次过多，已暂停；再次点击可继续。");
    } catch (error) {
      setStatus("error");
      setMessage(userFacingError(error, "迁移失败，已保留当前进度。再次点击可继续。"));
    }
  }

  async function importManual(): Promise<void> {
    if (words.length === 0) return;
    setStatus("import"); setMessage("");
    try {
      const result = await callServerTool("import_words", { words, source: "manual" });
      const parsed = manualSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("手动词表导入失败。");
      setMigration({ books: 0, book: { id: "manual", name: "手动词表", is_current: false }, unique: parsed.data.total, new: parsed.data.new, existing: parsed.data.existing });
      setStatus("done");
    } catch (error) { setStatus("error"); setMessage(userFacingError(error, "导入失败。")); }
  }

  async function startLearning(): Promise<void> {
    setStarting(true); setMessage("");
    try {
      const result = await callServerTool("prepare_daily_new_words", {});
      const parsed = preparedSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("今日新词未能准备，请重试。");
      setTodayPrepared(parsed.data.prepared);
      await sendUserMessage("开始今天的英语学习");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法开始学习，请重试。");
    } finally { setStarting(false); }
  }

  if (status === "done" && migration) return <section className="widget-card" aria-labelledby="import-title">
    <header className="widget-header"><span className="eyebrow">迁移完成</span><h1 id="import-title">已导入词库</h1><p>这些单词已经保存到 WordLoop。之后的学习和复习不再依赖扇贝。</p></header>
    <div className="result-strip" role="status"><span><strong>{migration.books}</strong><small>词书</small></span><span><strong>{migration.unique}</strong><small>去重后</small></span><span><strong>{migration.new}</strong><small>新增</small></span><span><strong>{migration.existing}</strong><small>已存在</small></span></div>
    <DailyNewWordControl limit={dailyLimit} todayPrepared={todayPrepared} onSaved={(value) => { setDailyLimit(value.limit); setTodayPrepared(value.prepared); }} />
    {message ? <p className="error-text" role="alert">{message}</p> : null}
    <Button onClick={() => void startLearning()} disabled={starting}>{starting ? "正在准备今日新词…" : "开始学习"} {!starting ? <ArrowIcon className="button-icon trailing" /> : null}</Button>
  </section>;

  return <section className="widget-card" aria-labelledby="import-title">
    <header className="widget-header"><span className="eyebrow">一次性词书迁移</span><h1 id="import-title">扇贝词书迁移</h1><p>完整导入一次后，WordLoop 成为长期词库的唯一来源。</p></header>
    {book ? <div className="source-card"><span className="eyebrow">当前词书</span><strong>{book.name}</strong></div> : null}
    <details className="advanced-options"><summary>高级选项</summary><label className="field-label" htmlFor="book-id">词书 ID</label><input id="book-id" value={bookId} onChange={(event) => setBookId(event.target.value)} placeholder="当前词书 ID" /></details>
    {preview ? <dl className="metrics import-metrics"><div><dt>未学习</dt><dd>{preview.unlearned}</dd></div><div><dt>学习中</dt><dd>{preview.learning}</dd></div><div><dt>已学习</dt><dd>{preview.simple_learned}</dd></div><div><dt>去重后</dt><dd>{preview.estimated_unique_total}</dd></div></dl> : null}
    {status === "import" && importProgress ? <div className="import-progress" role="status" aria-live="polite">
      <div className="import-progress-label"><span>正在导入{importProgress.state === "unlearned" ? "未学习" : importProgress.state === "learning" ? "学习中" : "已学习"}词…</span><strong>{importProgress.processed}{importProgress.total === null ? "" : ` / ${importProgress.total}`}</strong></div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={importProgress.total ?? undefined} aria-valuenow={importProgress.processed}><span style={{ width: importProgress.total ? `${Math.min(100, importProgress.processed / importProgress.total * 100)}%` : "22%" }} /></div>
      <p className="helper-text">每批立即写入，可安全离开后继续；不会重置已有学习记录。</p>
    </div> : null}
    {status === "error" ? <p className="error-text" role="alert">{message}</p> : null}
    <div className="button-row"><Button onClick={() => void importBook()} disabled={!bookId.trim() || status === "import"}>{status === "import" ? "正在导入…" : status === "error" && loadCheckpoint(bookId.trim()) ? "继续导入" : "导入整本词书"}</Button><Button className="secondary" onClick={() => void previewBook()} disabled={!bookId.trim() || status === "preview" || status === "import"}>{status === "preview" ? "正在读取全部页面…" : "预览"}</Button><Button className="secondary" onClick={() => void refresh()} disabled={status === "loading" || status === "import"}>刷新</Button></div>
    <p className="helper-text">要导入另一本词书，请先在扇贝切换词书，再回来刷新；也可在高级选项中填写词书 ID。</p>
    <details className="manual-import"><summary>手动导入词表</summary><textarea aria-label="要导入的单词" value={manual} onChange={(event) => setManual(event.target.value)} placeholder={"empirical\nsubtle\nconstrain"} rows={5}/><Button className="secondary" onClick={() => void importManual()} disabled={words.length === 0 || status === "import"}>导入 {words.length} 个单词</Button></details>
  </section>;
}
