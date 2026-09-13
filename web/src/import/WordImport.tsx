import { useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { ArrowIcon } from "../components/Icons.js";
import { callServerTool, sendUserMessage, structuredContentOf, updateModelContext } from "../mcpBridge.js";

const importResultSchema = z.object({
  date: z.string(), source: z.string(), total: z.number(), new: z.number(), existing: z.number(),
});

function parseWords(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\s,;，；]+/u).map((value) => value.trim()).filter((value) => {
    const normalized = value.toLocaleLowerCase("en-US");
    if (!value || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function WordImport(): React.JSX.Element {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<z.infer<typeof importResultSchema> | null>(null);
  const words = useMemo(() => parseWords(value), [value]);

  async function submit(): Promise<void> {
    if (words.length === 0) return;
    setStatus("loading");
    setMessage("");
    try {
      const toolResult = await callServerTool("import_words", { words, source: "shanbay" });
      if (toolResult.isError) throw new Error("The import could not be saved.");
      const parsed = importResultSchema.safeParse(structuredContentOf(toolResult));
      if (!parsed.success) throw new Error("The server returned an invalid import result.");
      setResult(parsed.data);
      setStatus("done");
      await updateModelContext(
        `Wordloop imported ${parsed.data.total} words for ${parsed.data.date}.`,
        { wordloopImport: parsed.data },
      );
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Import failed.");
    }
  }

  return <section className="widget-card" aria-labelledby="import-title">
    <header className="widget-header">
      <span className="eyebrow">Today&apos;s list</span>
      <h1 id="import-title">Import Shanbay words</h1>
      <p>Paste words separated by spaces, commas, semicolons, or new lines.</p>
    </header>
    <textarea
      aria-label="Words to import"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder={"empirical\nsubtle\nconstrain\nplausible"}
      rows={7}
    />
    {status === "done" && result ? <div className="result-strip" role="status">
      <span><strong>{result.total}</strong><small>Imported</small></span>
      <span><strong>{result.new}</strong><small>New</small></span>
      <span><strong>{result.existing}</strong><small>Existing</small></span>
    </div> : null}
    {status === "error" ? <p className="error-text" role="alert">{message}</p> : null}
    {status === "done" ? <Button onClick={() => void sendUserMessage("开始今天的英语学习")}>
      Start learning <ArrowIcon className="button-icon trailing" />
    </Button> :
      <Button onClick={() => void submit()} disabled={words.length === 0 || status === "loading"}>
        {status === "loading" ? "Importing…" : `Import ${words.length} ${words.length === 1 ? "word" : "words"}`}
      </Button>}
  </section>;
}
