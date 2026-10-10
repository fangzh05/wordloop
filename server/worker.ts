import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateWebUser, WebAuthError } from "./webAuth.js";
import { getPublicAuthConfig, getLegacyOwnerId, withUserIdentity } from "./db.js";
import { configureRuntimeEnv } from "./db.js";
import { createWordloopMcpServer, type WidgetKind } from "./mcpCore.js";
import { LESSON_WIDGET_VERSION } from "../shared/toolContracts.js";
import { handleWebApiRequest } from "./webApi.js";

type AssetBinding = { fetch(request: Request): Promise<Response> };

type WorkerEnv = {
  ASSETS?: AssetBinding;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DEV_USER_ID?: string;
  MERRIAM_WEBSTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  WORDLOOP_WEB_TOKEN?: string;
  SHANBAY_IMPORT_WORKER_URL?: string;
  SHANBAY_IMPORT_BRIDGE_SECRET?: string;
};

async function widgetHtml(kind: WidgetKind, assets?: AssetBinding): Promise<string> {
  if (!assets) throw new Error("Wordloop static assets are not configured.");
  const assetText = async (pathname: string): Promise<string> => {
    const asset = await assets.fetch(new Request(`https://wordloop-assets.internal${pathname}`));
    if (!asset.ok) throw new Error(`Wordloop widget asset is unavailable: ${pathname}`);
    return asset.text();
  };
  const [widgetCss, widgetJs] = await Promise.all([
    assetText("/widgets/widget.css"),
    assetText(`/widgets/${kind}.js`),
  ]);
  const versionAttribute = kind === "lesson" ? ` data-widget-version="${LESSON_WIDGET_VERSION}"` : "";
  return `<!doctype html><html${versionAttribute}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wordloop-widget" content="${kind}"><style>${widgetCss}</style></head><body><div id="root"></div><script>${widgetJs}</script></body></html>`;
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
  headers.set("access-control-allow-headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers });
}

export const worker = {
  async fetch(request: Request, env: WorkerEnv, _context?: unknown): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return response(JSON.stringify({ name: "wordloop", status: "ok", mcp: "/api/mcp", version: "0.1.0" }), "application/json; charset=utf-8");
    }
    if (url.pathname.startsWith("/api/")) configureRuntimeEnv(env as Record<string, unknown>);
    if (request.method === "GET" && url.pathname === "/api/web/auth/config") {
      try { return new Response(JSON.stringify(getPublicAuthConfig()), { headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
      catch { return response(JSON.stringify({ error: { message: "登录服务暂时不可用。" } }), "application/json", 503); }
    }
    if (url.pathname.startsWith("/api/web/")) return handleWebApiRequest(request);
    // GPT Sites reserves /mcp before requests reach the Worker. Keep the standard
    // Streamable HTTP protocol on a non-reserved public path instead.
    if (url.pathname !== "/api/mcp") {
      if (url.pathname.startsWith("/api/")) return response("Not found", "text/plain; charset=utf-8", 404);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return response("Not found", "text/plain; charset=utf-8", 404);
    }
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    try {
      const body = request.method === "POST" ? await request.clone().json() : null;
      const calls = Array.isArray(body) ? body : [body];
      const needsIdentity = calls.some((call: { method?: string } | null) => call?.method === "tools/call");
      const userId = needsIdentity ? await authenticateWebUser(request) : undefined;
      if (userId && userId !== getLegacyOwnerId() && calls.some((call: { params?: { name?: string } } | null) => call?.params?.name?.includes("shanbay"))) {
        throw new WebAuthError(403, "FORBIDDEN", "此导入仅供管理员使用。");
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = createWordloopMcpServer((kind) => widgetHtml(kind, env.ASSETS));
      await server.connect(transport);
      return withCors(await (userId ? withUserIdentity(userId, () => transport.handleRequest(request)) : transport.handleRequest(request)));
    } catch (error) {
      if (error instanceof WebAuthError) return response(JSON.stringify({ error: { code: error.code, message: error.message } }), "application/json", error.status);
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
