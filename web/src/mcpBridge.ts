import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type AppEvent =
  | { type: "toolinput"; value: Record<string, unknown> }
  | { type: "toolresult"; value: CallToolResult }
  | { type: "theme"; value: "light" | "dark" };

export type HostContext = {
  theme?: "light" | "dark";
  displayMode?: string;
  safeAreaInsets?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
};

type Listener = (event: AppEvent) => void;

declare global {
  interface Window {
    __WORDLOOP_PREVIEW__?: { theme?: "light" | "dark"; samplingAvailable?: boolean; payload?: Record<string, unknown>; toolResults?: Record<string, Record<string, unknown>> };
    openai?: {
      callTool?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
      sendFollowUpMessage?: (input: { prompt: string }) => Promise<void>;
    };
  }
}

const app = new App({ name: "wordloop-widget", version: "0.1.0" }, {}, { autoResize: true });
const listeners = new Set<Listener>();
let latestDataEvent: Extract<AppEvent, { type: "toolinput" | "toolresult" }> | undefined;
let latestThemeEvent: Extract<AppEvent, { type: "theme" }> | undefined;
let connected: Promise<void> | undefined;
let samplingAvailableCache: boolean | undefined;

function publish(event: AppEvent): void {
  if (event.type === "toolinput" || event.type === "toolresult") latestDataEvent = event;
  if (event.type === "theme") latestThemeEvent = event;
  for (const listener of listeners) listener(event);
}

function applyTheme(theme: unknown): void {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  publish({ type: "theme", value: resolved });
}

export function applyHostContext(ctx: HostContext | null | undefined): void {
  if (ctx?.theme) applyTheme(ctx.theme);

  document.documentElement.dataset.displayMode = ctx?.displayMode ?? "inline";

  const safe = ctx?.safeAreaInsets;
  document.documentElement.style.setProperty("--safe-area-top", `${safe?.top ?? 0}px`);
  document.documentElement.style.setProperty("--safe-area-right", `${safe?.right ?? 0}px`);
  document.documentElement.style.setProperty("--safe-area-bottom", `${safe?.bottom ?? 0}px`);
  document.documentElement.style.setProperty("--safe-area-left", `${safe?.left ?? 0}px`);
}

app.addEventListener("toolinput", (params) => publish({ type: "toolinput", value: params.arguments ?? {} }));
app.addEventListener("toolresult", (params) => publish({ type: "toolresult", value: params }));
app.addEventListener("hostcontextchanged", (params) => applyHostContext(params));

export function subscribeToApp(listener: Listener): () => void {
  listeners.add(listener);
  const preview = window.__WORDLOOP_PREVIEW__;
  if (preview?.payload) {
    listener({ type: "toolresult", value: { content: [], structuredContent: preview.payload } });
  } else if (latestDataEvent) {
    listener(latestDataEvent);
  }
  if (latestThemeEvent) listener(latestThemeEvent);
  return () => listeners.delete(listener);
}

export async function connectApp(): Promise<void> {
  if (window.__WORDLOOP_PREVIEW__) {
    applyTheme(window.__WORDLOOP_PREVIEW__.theme);
    applyHostContext({ displayMode: "inline" });
    return;
  }
  connected ??= app.connect().then(() => {
    const ctx = app.getHostContext();
    if (ctx) applyHostContext(ctx);
  });
  return connected;
}

/** Resolve the optional host capability once per widget runtime. */
export async function getSamplingAvailability(): Promise<boolean> {
  if (samplingAvailableCache !== undefined) return samplingAvailableCache;
  if (window.__WORDLOOP_PREVIEW__) {
    samplingAvailableCache = window.__WORDLOOP_PREVIEW__.samplingAvailable ?? true;
    return samplingAvailableCache;
  }
  try {
    await connectApp();
    samplingAvailableCache = Boolean(app.getHostCapabilities()?.sampling);
  } catch {
    samplingAvailableCache = false;
  }
  return samplingAvailableCache;
}

export async function callServerTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const previewResult = window.__WORDLOOP_PREVIEW__?.toolResults?.[name];
  if (previewResult) return { content: [], structuredContent: previewResult };
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

export async function sampleHostText(prompt: string, systemPrompt: string): Promise<string> {
  if (!(await getSamplingAvailability())) throw new Error("Sampling unavailable.");
  await connectApp();
  const result = await app.createSamplingMessage({
    messages: [{ role: "user", content: { type: "text", text: prompt } }],
    systemPrompt,
    maxTokens: 180,
    temperature: 0,
  });
  const blocks = Array.isArray(result.content) ? result.content : [result.content];
  const text = blocks.find((block) => block.type === "text");
  if (!text || text.type !== "text" || !text.text.trim()) throw new Error("ChatGPT 没有返回可用的批改结果。");
  return text.text.trim();
}

export async function requestFocusMode(): Promise<boolean> {
  await connectApp();
  const context = app.getHostContext();
  if (!context?.availableDisplayModes?.includes("fullscreen")) return false;
  const result = await app.requestDisplayMode({ mode: "fullscreen" });
  return result.mode === "fullscreen";
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
