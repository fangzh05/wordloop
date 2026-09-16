import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { configureRuntimeEnv } from "./db.js";
import { createWordloopMcpServer, type WidgetKind } from "./mcpCore.js";
import { LESSON_WIDGET_VERSION } from "../shared/toolContracts.js";

declare const __SITE_HTML__: string;
declare const __SITE_CSS__: string;
declare const __SITE_JS__: string;
declare const __WIDGET_JS__: string;
declare const __WIDGET_CSS__: string;
declare const __MIGRATION_SQL__: string;

type WorkerEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DEV_USER_ID?: string;
};

const siteHtml = typeof __SITE_HTML__ === "string" ? __SITE_HTML__ : "<!doctype html><title>Wordloop</title>";
const siteCss = typeof __SITE_CSS__ === "string" ? __SITE_CSS__ : "";
const siteJs = typeof __SITE_JS__ === "string" ? __SITE_JS__ : "";
const widgetJs = typeof __WIDGET_JS__ === "string" ? __WIDGET_JS__ : "";
const widgetCss = typeof __WIDGET_CSS__ === "string" ? __WIDGET_CSS__ : "";
const migrationSql = typeof __MIGRATION_SQL__ === "string" ? __MIGRATION_SQL__ : "-- Wordloop migration is embedded when the Site is built.\n";

function widgetHtml(kind: WidgetKind): Promise<string> {
  const versionAttribute = kind === "lesson" ? ` data-widget-version="${LESSON_WIDGET_VERSION}"` : "";
  return Promise.resolve(`<!doctype html><html${versionAttribute}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wordloop-widget" content="${kind}"><style>${widgetCss}</style></head><body><div id="root"></div><script>${widgetJs}</script></body></html>`);
}

function response(body: BodyInit | null, contentType: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": contentType.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function withCors(source: Response): Response {
  const headers = new Headers(source.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version, last-event-id");
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers });
}

export const worker = {
  async fetch(request: Request, env: WorkerEnv, _context?: unknown): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return response(siteHtml, "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/styles.css") return response(siteCss, "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/app.js") return response(siteJs, "text/javascript; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/setup.sql") return response(migrationSql, "text/plain; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/health") {
      return response(JSON.stringify({ name: "wordloop", status: "ok", mcp: "/api/mcp", version: "0.1.0" }), "application/json; charset=utf-8");
    }
    // GPT Sites reserves /mcp before requests reach the Worker. Keep the standard
    // Streamable HTTP protocol on a non-reserved public path instead.
    if (url.pathname !== "/api/mcp") return response("Not found", "text/plain; charset=utf-8", 404);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    try {
      configureRuntimeEnv(env as Record<string, unknown>);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = createWordloopMcpServer(widgetHtml);
      await server.connect(transport);
      return withCors(await transport.handleRequest(request));
    } catch (error) {
      console.error("Wordloop MCP request failed", error instanceof Error ? error.message : "unknown error");
      return withCors(response(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      }), "application/json; charset=utf-8", 500));
    }
  },
};

export default worker;
