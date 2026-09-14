import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { ArrowIcon } from "../components/Icons.js";
import { callServerTool, sendUserMessage, structuredContentOf, updateModelContext } from "../mcpBridge.js";

const bookSchema = z.object({ id: z.string(), name: z.string(), is_current: z.boolean() });
const previewSchema = z.object({ book: bookSchema, unlearned: z.number(), learning: z.number(), simple_learned: z.number(), estimated_unique_total: z.number() });
const migrationSchema = z.object({ books: z.number(), book: bookSchema, unique: z.number(), new: z.number(), existing: z.number() });
const manualSchema = z.object({ date: z.string(), source: z.string(), total: z.number(), new: z.number(), existing: z.number() });
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

export function WordImport(): React.JSX.Element {
  const [book, setBook] = useState<z.infer<typeof bookSchema> | null>(null);
  const [preview, setPreview] = useState<z.infer<typeof previewSchema> | null>(null);
  const [migration, setMigration] = useState<z.infer<typeof migrationSchema> | null>(null);
  const [bookId, setBookId] = useState("");
  const [manual, setManual] = useState("");
  const [status, setStatus] = useState<"loading" | "idle" | "preview" | "import" | "done" | "error">("loading");
  const [message, setMessage] = useState("");
  const [importProgress, setImportProgress] = useState<{ processed: number; total: number | null; state: string } | null>(null);
  const words = useMemo(() => parseWords(manual), [manual]);

  async function refresh(): Promise<void> {
    setStatus("loading"); setMessage(""); setPreview(null);
    try {
      const result = await callServerTool("get_current_shanbay_book", {});
      const parsed = bookSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("Shanbay 登录已失效或尚未配置。");
      setBook(parsed.data); setBookId(parsed.data.id); setStatus("idle");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "无法读取扇贝词书。"); }
  }

  useEffect(() => { void refresh(); }, []);

  async function previewBook(): Promise<void> {
    if (!bookId.trim()) return;
    setStatus("preview"); setMessage("");
    try {
      const result = await callServerTool("preview_shanbay_book", { book_id: bookId.trim() });
      const parsed = previewSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("无法预览这本词书。");
      setPreview(parsed.data); setStatus("idle");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "预览失败。"); }
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
      setMessage(error instanceof Error ? error.message : "迁移失败，已保留当前进度。再次点击可继续。");
    }
  }

  async function importManual(): Promise<void> {
    if (words.length === 0) return;
    setStatus("import"); setMessage("");
    try {
      const result = await callServerTool("import_words", { words, source: "manual" });
      const parsed = manualSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("手动词表导入失败。");
      setMigration({ books: 0, book: { id: "manual", name: "Manual list", is_current: false }, unique: parsed.data.total, new: parsed.data.new, existing: parsed.data.existing });
      setStatus("done");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "导入失败。"); }
  }

  if (status === "done" && migration) return <section className="widget-card" aria-labelledby="import-title">
    <header className="widget-header"><span className="eyebrow">Migration complete</span><h1 id="import-title">Imported</h1><p>Words now belong to Wordloop. Shanbay changes will not overwrite them.</p></header>
    <div className="result-strip" role="status"><span><strong>{migration.books}</strong><small>Books</small></span><span><strong>{migration.unique}</strong><small>Unique</small></span><span><strong>{migration.new}</strong><small>New</small></span><span><strong>{migration.existing}</strong><small>Existing</small></span></div>
    <Button onClick={() => void sendUserMessage("准备今天的新词并开始预测试")}>Start pretest <ArrowIcon className="button-icon trailing" /></Button>
  </section>;

  return <section className="widget-card" aria-labelledby="import-title">
    <header className="widget-header"><span className="eyebrow">One-time migration</span><h1 id="import-title">Shanbay Import</h1><p>Import the complete book once. Wordloop becomes the permanent source of truth.</p></header>
    {book ? <div className="source-card"><span className="eyebrow">Current book</span><strong>{book.name}</strong><small>ID: {book.id}</small></div> : null}
    <label className="field-label" htmlFor="book-id">Materialbook ID</label>
    <input id="book-id" value={bookId} onChange={(event) => setBookId(event.target.value)} placeholder="Current book ID" />
    {preview ? <dl className="metrics import-metrics"><div><dt>Unlearned</dt><dd>{preview.unlearned}</dd></div><div><dt>Learning</dt><dd>{preview.learning}</dd></div><div><dt>Learned</dt><dd>{preview.simple_learned}</dd></div><div><dt>Unique</dt><dd>{preview.estimated_unique_total}</dd></div></dl> : null}
    {status === "import" && importProgress ? <div className="import-progress" role="status" aria-live="polite">
      <div className="import-progress-label"><span>Importing {importProgress.state.replace("_", " ")}…</span><strong>{importProgress.processed}{importProgress.total === null ? "" : ` / ${importProgress.total}`}</strong></div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={importProgress.total ?? undefined} aria-valuenow={importProgress.processed}><span style={{ width: importProgress.total ? `${Math.min(100, importProgress.processed / importProgress.total * 100)}%` : "22%" }} /></div>
      <p className="helper-text">每批立即写入，可安全离开后继续；不会重置已有学习记录。</p>
    </div> : null}
    {status === "error" ? <p className="error-text" role="alert">{message}</p> : null}
    <div className="button-row"><Button onClick={() => void importBook()} disabled={!bookId.trim() || status === "import"}>{status === "import" ? "Importing…" : status === "error" && loadCheckpoint(bookId.trim()) ? "Resume import" : "Import entire book"}</Button><Button className="secondary" onClick={() => void previewBook()} disabled={!bookId.trim() || status === "preview" || status === "import"}>{status === "preview" ? "Reading all pages…" : "Preview"}</Button><Button className="secondary" onClick={() => void refresh()} disabled={status === "loading" || status === "import"}>Refresh</Button></div>
    <p className="helper-text">To migrate another book, switch it in Shanbay and refresh, or enter its materialbook ID.</p>
    <details className="manual-import"><summary>Import manually</summary><textarea aria-label="Words to import" value={manual} onChange={(event) => setManual(event.target.value)} placeholder={"empirical\nsubtle\nconstrain"} rows={5}/><Button className="secondary" onClick={() => void importManual()} disabled={words.length === 0 || status === "import"}>Import {words.length} words</Button></details>
  </section>;
}
