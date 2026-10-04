import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { DurableObject } from "cloudflare:workers";
import { verifyBridgeRequest } from "../../../shared/importBridgeAuth.js";
import { ShanbayClient, ShanbayError, type ShanbayImportCursor, type ShanbayWordChunk } from "../../../server/integrations/shanbay/client.js";
import type { ShanbayBook } from "../../../server/integrations/shanbay/types.js";

interface Env { BROWSER: Fetcher; IMPORTS: DurableObjectNamespace<ShanbayImportSession>; BRIDGE_SECRET: string }
type Action = "start" | "status" | "chunk" | "ack" | "cancel";
interface Input { userId: string; action: Action; jobId?: string; chunkId?: string; added?: number; existing?: number }
interface Job {
  id: string; sessionId: string | null; expiresAt: number;
  state: "waiting_login" | "ready" | "importing" | "completed" | "cancelled" | "expired" | "failed";
  book?: ShanbayBook; cursor?: ShanbayImportCursor;
  pending?: { id: string; chunk: ShanbayWordChunk }; lastAck?: string;
  processed: number; added: number; existing: number;
  completePending?: boolean;
}
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const active = (job: Job) => ["waiting_login", "ready", "importing"].includes(job.state);
class BrowserStepError extends Error { constructor(readonly step: string, readonly reason: string) { super(step); } }
function browserReason(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN";
  return error.message.includes("code: 429") ? "RATE_LIMITED" : error.message.match(/net::[A-Z_]+/)?.[0] ?? (error.name === "TimeoutError" ? "TIMEOUT" : "PROVIDER_ERROR");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return reply({ ok: true });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/import" || !env.BRIDGE_SECRET) return reply({ error: "UNAUTHORIZED" }, 401);
    const body = await request.text();
    if (body.length > 4096 || !await verifyBridgeRequest(env.BRIDGE_SECRET, request.headers.get("x-bridge-time") ?? "", body, request.headers.get("x-bridge-signature") ?? "")) return reply({ error: "UNAUTHORIZED" }, 401);
    let input: Input;
    try { input = JSON.parse(body); } catch { return reply({ error: "INVALID_REQUEST" }, 400); }
    if (!/^[0-9a-f-]{36}$/i.test(input.userId ?? "") || !["start", "status", "chunk", "ack", "cancel"].includes(input.action)) return reply({ error: "INVALID_REQUEST" }, 400);
    // Only the authenticated WordLoop backend chooses this identity.
    return env.IMPORTS.get(env.IMPORTS.idFromName(input.userId)).fetch("https://internal/import", { method: "POST", body });
  },
};

export class ShanbayImportSession extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work); this.tail = next.catch(() => undefined); return next;
  }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json<Input>();
    return this.serial(async () => {
      try { return await this.handle(input); }
      catch (error) {
        if (error instanceof BrowserStepError) return reply({ error: error.reason === "RATE_LIMITED" ? "BROWSER_RATE_LIMITED" : "BROWSER_UNAVAILABLE" }, 503);
        if (error instanceof ShanbayError) return reply({ error: error.code === "auth" ? "LOGIN_REQUIRED" : "SHANBAY_UNAVAILABLE" }, 409);
        // Never include browser URLs, cookies or provider errors in responses/logs.
        return reply({ error: "BROWSER_UNAVAILABLE" }, 503);
      }
    });
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const job = await this.ctx.storage.get<Job>("job");
      if (job && active(job)) await this.close(job, "expired");
    });
  }
  private view(job: Job) { return { jobId: job.id, state: job.state, expiresAt: job.expiresAt, book: job.book, processed: job.processed, added: job.added, existing: job.existing }; }
  private save(job: Job) { return this.ctx.storage.put("job", job); }
  private async close(job: Job, state: Job["state"]) {
    if (job.sessionId) {
      // Leave sessionId intact if close fails: the alarm can retry cleanup.
      const browser = await puppeteer.connect(this.env.BROWSER, job.sessionId).catch(async (error) => {
        const sessions = await puppeteer.sessions(this.env.BROWSER);
        if (sessions.some((session) => session.sessionId === job.sessionId)) throw error;
        return null;
      });
      if (browser) { try { await browser.close(); } finally { browser.disconnect(); } }
    }
    job.sessionId = null; job.state = state; delete job.pending;
    await this.save(job); await this.ctx.storage.deleteAlarm();
  }
  private async browserWork<T>(job: Job, work: (browser: Browser, page: Page) => Promise<T>): Promise<T> {
    if (!job.sessionId) throw new Error("Missing session");
    const browser = await puppeteer.connect(this.env.BROWSER, job.sessionId);
    try {
      const pages = await browser.pages();
      const page = pages.find((page) => { try { return new URL(page.url()).hostname.endsWith(".shanbay.com"); } catch { return false; } }) ?? pages[0];
      if (!page) throw new Error("Missing page");
      return await work(browser, page);
    } finally { browser.disconnect(); }
  }
  private async client(page: Page): Promise<ShanbayClient> {
    const cookies = await page.cookies("https://apiv3.shanbay.com", "https://web.shanbay.com");
    const csrf = cookies.find((cookie) => cookie.name === "csrftoken")?.value ?? "";
    // Fetch inside the remote browser, preserving both its cookies and source IP.
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (new URL(url).origin !== "https://apiv3.shanbay.com") throw new Error("Invalid destination");
      const result = await page.evaluate(async (url, csrf) => {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 14000);
        try {
          const response = await fetch(url, { credentials: "include", headers: { accept: "application/json", ...(csrf ? { "x-csrftoken": csrf } : {}) }, signal: controller.signal });
          return { status: response.status, body: await response.text() };
        } finally { clearTimeout(timer); }
      }, url, csrf);
      return new Response(result.body, { status: result.status });
    };
    return new ShanbayClient("", fetcher, "");
  }
  private async handle(input: Input): Promise<Response> {
    let job = await this.ctx.storage.get<Job>("job");
    if (job && active(job) && Date.now() >= job.expiresAt) await this.close(job, "expired");
    if (job && active(job) && job.completePending) await this.close(job, "completed");
    if (input.action === "start") {
      if (!job || !active(job)) {
        const browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: 600000, recording: false }).catch((error) => { throw new BrowserStepError("launch", browserReason(error)); });
        job = { id: crypto.randomUUID(), sessionId: browser.sessionId(), expiresAt: Date.now() + 20 * 60_000, state: "waiting_login", processed: 0, added: 0, existing: 0 };
        await this.save(job); await this.ctx.storage.setAlarm(job.expiresAt);
        try {
          const page = (await browser.pages())[0] ?? await browser.newPage();
          await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
          await page.goto("https://web.shanbay.com/web/account/login", { waitUntil: "domcontentloaded", timeout: 25000 });
        } catch (error) {
          await browser.close(); job.sessionId = null; job.state = "failed"; await this.save(job); await this.ctx.storage.deleteAlarm(); throw new BrowserStepError("navigate_login", browserReason(error));
        } finally { browser.disconnect(); }
      }
      const liveUrl = await this.browserWork(job, async (_, page) => {
        const cdp = await page.createCDPSession();
        try { return (await cdp.send("Cloudflare.getLiveView", { mode: "tab", expiresInMs: 300000 })).devtoolsFrontendUrl; }
        finally { await cdp.detach(); }
      }).catch((error) => { throw new BrowserStepError("live_view", browserReason(error)); });
      return reply({ ...this.view(job), liveUrl });
    }
    if (!job || input.jobId !== job.id) return reply({ error: "JOB_NOT_FOUND" }, 404);
    if (job.completePending && active(job)) { await this.close(job, "completed"); return reply(this.view(job)); }
    if (input.action === "cancel" && active(job)) { await this.close(job, "cancelled"); return reply(this.view(job)); }
    if (!active(job)) return reply(this.view(job));
    if (input.action === "status") {
      if (job.state === "waiting_login") {
        try {
          job.book = await this.browserWork(job, async (_, page) => (await this.client(page)).getCurrentBook());
          job.state = "ready"; await this.save(job);
        } catch (error) {
          if (!(error instanceof ShanbayError)) throw error;
          if (!["auth", "missing_book"].includes(error.code)) return reply({ ...this.view(job), warning: "SHANBAY_UNAVAILABLE" });
        }
      }
      return reply(this.view(job));
    }
    if (!job.book) return reply({ error: "LOGIN_REQUIRED" }, 409);
    if (input.action === "chunk") {
      if (!job.pending) {
        const chunk = await this.browserWork(job, async (_, page) => (await this.client(page)).getWordChunk(job!.book!.id, job!.cursor));
        job.pending = { id: crypto.randomUUID(), chunk }; job.state = "importing"; await this.save(job);
      }
      return reply({ ...this.view(job), chunkId: job.pending.id, words: job.pending.chunk.words });
    }
    if (input.action === "ack") {
      if (input.chunkId === job.lastAck) return reply(this.view(job));
      if (!job.pending || input.chunkId !== job.pending.id || !Number.isInteger(input.added) || !Number.isInteger(input.existing) || input.added! < 0 || input.existing! < 0 || input.added! + input.existing! > job.pending.chunk.words.length) return reply({ error: "INVALID_ACK" }, 409);
      const next = job.pending.chunk.next_cursor;
      job.processed += job.pending.chunk.words.length; job.added += input.added!; job.existing += input.existing!;
      job.lastAck = job.pending.id; delete job.pending; job.cursor = next ?? undefined;
      if (!next) job.completePending = true;
      await this.save(job);
      if (!next) await this.close(job, "completed");
      return reply(this.view(job));
    }
    return reply({ error: "INVALID_REQUEST" }, 400);
  }
}
