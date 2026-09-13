import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createWordloopMcpServer, type WidgetKind } from "./mcpCore.js";
import { WIDGET_URIS } from "./tools/renderWidgets.js";

const projectRoot = path.resolve(process.env.WORDLOOP_ROOT ?? process.cwd());

export async function widgetHtml(kind: WidgetKind, preview?: Record<string, unknown>): Promise<string> {
  const webDist = path.join(projectRoot, "web", "dist");
  const [javascript, css] = await Promise.all([
    readFile(path.join(webDist, "widget.js"), "utf8"),
    readFile(path.join(webDist, "widget.css"), "utf8"),
  ]);
  const previewScript = preview
    ? `<script>window.__WORDLOOP_PREVIEW__=${JSON.stringify(preview).replaceAll("<", "\\u003c")}</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wordloop-widget" content="${kind}"><style>${css}</style></head><body><div id="root"></div>${previewScript}<script>${javascript}</script></body></html>`;
}

export function createWordloopServer(): McpServer {
  return createWordloopMcpServer((kind) => widgetHtml(kind));
}
