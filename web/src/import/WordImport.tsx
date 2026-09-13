import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { ArrowIcon } from "../components/Icons.js";
import { callServerTool, sendUserMessage, structuredContentOf, updateModelContext } from "../mcpBridge.js";

const bookSchema = z.object({ id: z.string(), name: z.string(), is_current: z.boolean() });
const previewSchema = z.object({ book: bookSchema, unlearned: z.number(), learning: z.number(), simple_learned: z.number(), estimated_unique_total: z.number() });
const migrationSchema = z.object({ books: z.number(), book: bookSchema, unique: z.number(), new: z.number(), existing: z.number() });
const manualSchema = z.object({ date: z.string(), source: z.string(), total: z.number(), new: z.number(), existing: z.number() });

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
    if (!bookId.trim()) return;
    setStatus("import"); setMessage("");
    try {
      const result = await callServerTool("import_shanbay_book", { book_id: bookId.trim() });
      const parsed = migrationSchema.safeParse(structuredContentOf(result));
      if (result.isError || !parsed.success) throw new Error("词书迁移失败。");
      setMigration(parsed.data); setStatus("done");
      await updateModelContext("A Shanbay book was migrated into the independent Wordloop vocabulary pool.", { shanbayMigration: parsed.data });
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "迁移失败。"); }
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
    {status === "error" ? <p className="error-text" role="alert">{message}</p> : null}
    <div className="button-row"><Button onClick={() => void importBook()} disabled={!bookId.trim() || status === "import"}>{status === "import" ? "Importing entire book…" : "Import entire book"}</Button><Button className="secondary" onClick={() => void previewBook()} disabled={!bookId.trim() || status === "preview"}>{status === "preview" ? "Reading all pages…" : "Preview"}</Button><Button className="secondary" onClick={() => void refresh()} disabled={status === "loading"}>Refresh</Button></div>
    <p className="helper-text">To migrate another book, switch it in Shanbay and refresh, or enter its materialbook ID.</p>
    <details className="manual-import"><summary>Import manually</summary><textarea aria-label="Words to import" value={manual} onChange={(event) => setManual(event.target.value)} placeholder={"empirical\nsubtle\nconstrain"} rows={5}/><Button className="secondary" onClick={() => void importManual()} disabled={words.length === 0 || status === "import"}>Import {words.length} words</Button></details>
  </section>;
}
