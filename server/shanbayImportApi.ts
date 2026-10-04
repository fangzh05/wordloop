import { z } from "zod";
import { getAuthenticatedUserId, getShanbayImportBridgeConfig } from "./db.js";
import { bridgeSignature } from "../shared/importBridgeAuth.js";
import { persistShanbayBook } from "./integrations/shanbay/importer.js";
import type { ShanbayBook, ShanbayWord } from "./integrations/shanbay/types.js";

export async function handleShanbayImportRequest(request: Request): Promise<Response> {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const config = getShanbayImportBridgeConfig();
  if (!config) return respond({ error: { code: "IMPORT_NOT_CONFIGURED", message: "扇贝导入尚未开放。" } }, 503);
  if (request.method !== "POST") return respond({ error: { code: "METHOD_NOT_ALLOWED", message: "请通过词库入口操作。" } }, 405);
  const action = new URL(request.url).pathname.split("/").at(-1);
  if (!["start", "status", "chunk", "cancel"].includes(action ?? "")) return respond({ error: { code: "INVALID_REQUEST", message: "操作无效。" } }, 400);
  const input = z.object({ jobId: z.string().uuid().optional() }).strict().safeParse(await request.json().catch(() => null));
  if (!input.success || (action !== "start" && !input.data.jobId)) return respond({ error: { code: "INVALID_REQUEST", message: "导入任务无效。" } }, 400);
  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    // User identity always comes from the existing authenticated request scope.
    const body = JSON.stringify({ userId: getAuthenticatedUserId(), action, ...input.data, ...extra });
    const timestamp = String(Date.now());
    const response = await fetch(new URL("/import", config.url), { method: "POST", headers: { "content-type": "application/json", "x-bridge-time": timestamp, "x-bridge-signature": await bridgeSignature(config.secret, timestamp, body) }, body, signal: AbortSignal.timeout(60_000) });
    const data = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "IMPORT_UNAVAILABLE");
    return data;
  };
  try {
    const data = await call(action!);
    if (action === "chunk" && data.chunkId) {
      const saved = await persistShanbayBook(data.book as ShanbayBook, data.words as ShanbayWord[]);
      const acknowledged = await call("ack", { chunkId: data.chunkId, added: saved.new, existing: saved.existing });
      return respond(acknowledged);
    }
    return respond(data);
  } catch (error) {
    const code = error instanceof Error ? error.message : "IMPORT_UNAVAILABLE";
    const messages: Record<string, string> = { LOGIN_REQUIRED: "请先在扇贝页面完成登录。", JOB_NOT_FOUND: "导入任务已失效，请重新连接。", SHANBAY_UNAVAILABLE: "暂时无法读取扇贝词书，请稍后重试。", BROWSER_UNAVAILABLE: "远程登录暂时不可用，请重试或重新连接。", BROWSER_RATE_LIMITED: "浏览器额度或并发暂时受限，请稍后重试。" };
    return respond({ error: { code: code in messages ? code : "IMPORT_UNAVAILABLE", message: messages[code] ?? "导入暂时失败，重试会继续当前进度。" } }, 503);
  }
}
