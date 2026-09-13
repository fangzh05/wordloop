import "dotenv/config";
import { randomUUID } from "node:crypto";
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
      if (!["import", "pretest", "dashboard", "pronunciation", "dictation"].includes(kind)) {
        res.status(404).send("Unknown widget.");
        return;
      }
      const payloads: Record<string, Record<string, unknown>> = {
        import: { widget: "import" },
        pretest: {
          widget: "pretest",
          items: [
            { word: "empirical", ipa: "/ɪmˈpɪrɪkəl/", prompt: "经验性的；以观察 / 实验为依据的", direction: "cn_to_en" },
            { word: "subtle", ipa: "/ˈsʌtəl/", prompt: "subtle", direction: "en_definition" },
          ],
        },
        dashboard: {
          widget: "dashboard",
          progress: {
            today: { total: 50, known: 13, uncertain: 8, unknown: 5, completed: 26 },
            all_time: { total_words: 821, mastered: 574, learning: 230, error_book: 7 },
          },
        },
        pronunciation: {
          widget: "pronunciation",
          words: [
            { word: "plausible", ipa: "/ˈplɔːzəbəl/" },
            { word: "empirical", ipa: "/ɪmˈpɪrɪkəl/" },
            { word: "rigorous", ipa: "/ˈrɪɡərəs/" },
          ],
        },
        dictation: { widget: "dictation", title: "Dictation 1", text: "Rigorous evidence can constrain plausible explanations without eliminating uncertainty." },
      };
      const theme = req.query.theme === "dark" ? "dark" : "light";
      res.type("html").send(await widgetHtml(kind as "import" | "pretest" | "dashboard" | "pronunciation" | "dictation", { theme, payload: payloads[kind] }));
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

const isEntrypoint = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
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
