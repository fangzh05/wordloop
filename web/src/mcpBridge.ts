import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type AppEvent =
  | { type: "toolinput"; value: Record<string, unknown> }
  | { type: "toolresult"; value: CallToolResult }
  | { type: "theme"; value: "light" | "dark" };

type Listener = (event: AppEvent) => void;

declare global {
  interface Window {
    __WORDLOOP_PREVIEW__?: { theme?: "light" | "dark"; payload?: Record<string, unknown> };
    openai?: {
      callTool?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
      sendFollowUpMessage?: (input: { prompt: string }) => Promise<void>;
    };
  }
}

const app = new App({ name: "wordloop-widget", version: "0.1.0" }, {}, { autoResize: true });
const listeners = new Set<Listener>();
let connected: Promise<void> | undefined;

function publish(event: AppEvent): void {
  for (const listener of listeners) listener(event);
}

function applyTheme(theme: unknown): void {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  publish({ type: "theme", value: resolved });
}

app.addEventListener("toolinput", (params) => publish({ type: "toolinput", value: params.arguments ?? {} }));
app.addEventListener("toolresult", (params) => publish({ type: "toolresult", value: params }));
app.addEventListener("hostcontextchanged", (params) => applyTheme(params.theme));

export function subscribeToApp(listener: Listener): () => void {
  listeners.add(listener);
  const preview = window.__WORDLOOP_PREVIEW__;
  if (preview?.payload) {
    listener({ type: "toolresult", value: { content: [], structuredContent: preview.payload } });
  }
  return () => listeners.delete(listener);
}

export async function connectApp(): Promise<void> {
  if (window.__WORDLOOP_PREVIEW__) {
    applyTheme(window.__WORDLOOP_PREVIEW__.theme);
    return;
  }
  connected ??= app.connect().then(() => applyTheme(app.getHostContext()?.theme));
  return connected;
}

export async function callServerTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    await connectApp();
    if (app.getHostCapabilities()?.serverTools) {
      return await app.callServerTool({ name, arguments: args });
    }
  } catch {
    // A legacy ChatGPT host may expose only window.openai.callTool.
  }
  if (typeof window.openai?.callTool === "function") return window.openai.callTool(name, args);
  throw new Error("This host cannot call Wordloop tools from the widget.");
}

export async function sendUserMessage(text: string): Promise<void> {
  try {
    await connectApp();
    if (app.getHostCapabilities()?.message) {
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      if (!result.isError) return;
    }
  } catch {
    // Try the feature-detected legacy enhancement below.
  }
  if (typeof window.openai?.sendFollowUpMessage === "function") {
    await window.openai.sendFollowUpMessage({ prompt: text });
    return;
  }
  throw new Error("This host cannot send a follow-up message.");
}

export async function updateModelContext(text: string, structuredContent?: Record<string, unknown>): Promise<void> {
  await connectApp();
  if (!app.getHostCapabilities()?.updateModelContext) return;
  await app.updateModelContext({
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  });
}

export function structuredContentOf(result: CallToolResult): unknown {
  return result.structuredContent;
}
