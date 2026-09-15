import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createWordloopServer, widgetHtml } from "./mcp.js";

const transports = new Map<string, StreamableHTTPServerTransport>();

function sessionId(req: Request): string | undefined {
  const header = req.headers["mcp-session-id"];
  return typeof header === "string" ? header : undefined;
}

function sendRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function createHttpApp() {
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",").map((value) => value.trim()).filter(Boolean);
  const app = createMcpExpressApp({ host, ...(allowedHosts?.length ? { allowedHosts } : {}) });

  app.get("/", (_req, res) => {
    res.json({ name: "wordloop", status: "ok", mcp: "/mcp", version: "0.1.0" });
  });

  if (process.env.ENABLE_WIDGET_PREVIEW === "true") {
    app.get("/preview/:kind", async (req, res) => {
      const kind = req.params.kind;
      if (!["import", "pretest", "review", "dashboard", "pronunciation", "dictation", "lesson"].includes(kind)) {
        res.status(404).send("Unknown widget.");
        return;
      }
      const payloads: Record<string, Record<string, unknown>> = {
        import: { widget: "import" },
        pretest: {
          widget: "pretest",
          items: [
            { word: "empirical", ipa: "/ɪmˈpɪrɪkəl/", part_of_speech: "adj.", meaning_zh: "经验性的；以观察或实验为依据的", prompt: "经验性的；以观察 / 实验为依据的", direction: "cn_to_en" },
            { word: "subtle", ipa: "/ˈsʌtəl/", part_of_speech: "adj.", meaning_zh: "微妙的；不易察觉的", prompt: "Give an English definition for subtle without using the word itself.", direction: "en_definition" },
          ],
        },
        review: {
          widget: "review",
          items: [
            { word: "recur", meaning_zh: "再次发生；复发", part_of_speech: "v.", direction: "cn_to_en", error_layers: ["meaning"], is_due: true, review_kind: "both", next_review_at: "2026-09-13T00:00:00Z" },
            { word: "subtle", meaning_zh: "微妙的；不易察觉的", part_of_speech: "adj.", direction: "cn_to_en", error_layers: ["collocation"], is_due: false, review_kind: "error_repair", next_review_at: "2026-09-20T00:00:00Z" },
          ],
        },
        dashboard: {
          widget: "dashboard",
          progress: {
            today: { total: 50, known: 13, uncertain: 8, unknown: 5, completed: 26 },
            all_time: { total_words: 821, mastered: 574, learning: 230, error_book: 7 },
            fsrs: { due_now: 4, due_today: 11, tomorrow: 8, due_next_7_days: 38, average_stability: 12.4 },
            settings: { daily_new_word_limit: 50 },
          },
        },
        pronunciation: {
          widget: "pronunciation",
          words: [
            { word: "plausible", ipa: "/ˈplɔːzəbəl/", part_of_speech: "adj.", meaning_zh: "看似合理的；可信的" },
            { word: "empirical", ipa: "/ɪmˈpɪrɪkəl/", part_of_speech: "adj.", meaning_zh: "经验性的；实证的" },
            { word: "rigorous", ipa: "/ˈrɪɡərəs/", part_of_speech: "adj.", meaning_zh: "严谨的；严格的" },
          ],
        },
        dictation: { widget: "dictation", title: "听写 1", text: "Rigorous evidence can constrain plausible explanations without eliminating uncertainty." },
        lesson: {
          widget: "lesson",
          mode: "explain",
          progress: "1 / 3",
          word: "recur",
          ipa: "/rɪˈkɜːr/",
          part_of_speech: "v.",
          meaning_zh: "再次发生；反复出现",
          collocations: ["recur frequently", "recur at regular intervals"],
          derivations: ["recurrence n.", "recurrent adj."],
          example_en: "Symptoms may recur several weeks after treatment.",
          note: "医学语境常见 recurrent infection / tumor recurrence",
          exercise: {
            activity_type: "translation_cn_to_en",
            instruction: "使用 recur 翻译下面句子",
            prompt: "研究人员发现，这种并发症在老年患者中更容易再次出现。",
            multiline: false,
          }
        },
      };
      const theme = req.query.theme === "dark" ? "dark" : "light";
      const toolResults = kind === "import" ? {
        get_current_shanbay_book: { id: "materialbook-2026", name: "考研英语词汇", is_current: true },
        preview_shanbay_book: { book: { id: "materialbook-2026", name: "考研英语词汇", is_current: true }, unlearned: 3812, learning: 624, simple_learned: 1046, estimated_unique_total: 5482 },
      } : undefined;
      res.type("html").send(await widgetHtml(kind as "import" | "pretest" | "review" | "dashboard" | "pronunciation" | "dictation" | "lesson", { theme, payload: payloads[kind], toolResults }));
    });
  }

  app.post("/mcp", async (req, res) => {
    try {
      const requestedSession = sessionId(req);
      let transport = requestedSession ? transports.get(requestedSession) : undefined;
      if (!transport && !requestedSession && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => { transports.set(id, transport!); },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await createWordloopServer().connect(transport);
      } else if (!transport) {
        sendRpcError(res, 400, "Missing or invalid MCP session.");
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP POST failed:", error instanceof Error ? error.message : "unknown error");
      if (!res.headersSent) sendRpcError(res, 500, "Internal server error.");
    }
  });

  const handleExistingSession = async (req: Request, res: Response): Promise<void> => {
    const id = sessionId(req);
    const transport = id ? transports.get(id) : undefined;
    if (!transport) {
      sendRpcError(res, 400, "Missing or invalid MCP session.");
      return;
    }
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`MCP ${req.method} failed:`, error instanceof Error ? error.message : "unknown error");
      if (!res.headersSent) sendRpcError(res, 500, "Internal server error.");
    }
  };

  app.get("/mcp", handleExistingSession);
  app.delete("/mcp", handleExistingSession);
  return app;
}

const isEntrypoint = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
  : false;
if (isEntrypoint) {
  const argumentValue = (name: string): string | undefined => {
    const position = process.argv.indexOf(name);
    return position >= 0 ? process.argv[position + 1] : undefined;
  };
  const port = Number(argumentValue("--port") ?? process.env.PORT ?? 3000);
  const host = argumentValue("--host") ?? process.env.HOST ?? "127.0.0.1";
  process.env.PORT = String(port);
  process.env.HOST = host;
  if (process.argv.includes("--strictPort")) {
    process.env.ENABLE_WIDGET_PREVIEW = "true";
    process.env.ALLOWED_HOSTS = [process.env.ALLOWED_HOSTS, "terminal.local"].filter(Boolean).join(",");
  }
  createHttpApp().listen(port, host, () => {
    console.log(`Wordloop listening on http://${host}:${port}`);
  });
}

async function shutdown(): Promise<void> {
  await Promise.all([...transports.values()].map((transport) => transport.close()));
  transports.clear();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
