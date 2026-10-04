import { beforeEach, describe, expect, it, vi } from "vitest";
const browser = vi.hoisted(() => ({ close: vi.fn(), disconnect: vi.fn(), page: { cookies: vi.fn(), evaluate: vi.fn() }, connect: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: any, public env: any) {} } }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { connect: browser.connect } }));
const shanbay = vi.hoisted(() => ({ chunk: vi.fn(), book: vi.fn() }));
vi.mock("../../../server/integrations/shanbay/client.js", () => ({ ShanbayClient: class { getWordChunk = shanbay.chunk; getCurrentBook = shanbay.book; }, ShanbayError: class extends Error {} }));
import { ShanbayImportSession } from "../src/index.js";
const job = () => ({ id: "job-a", sessionId: "session-a", expiresAt: Date.now() + 60000, state: "ready", book: { id: "book-a", name: "My book" }, processed: 0, added: 0, existing: 0 });
function harness(initial = job()) {
  let value: any = structuredClone(initial);
  const storage = { get: vi.fn(async () => structuredClone(value)), put: vi.fn(async (_: string, next: any) => { value = structuredClone(next); }), setAlarm: vi.fn(), deleteAlarm: vi.fn() };
  const instance = new ShanbayImportSession({ storage } as any, { BROWSER: {} } as any);
  return { instance, storage, value: () => value, call: (action: string, extra = {}) => instance.fetch(new Request("https://internal/import", { method: "POST", body: JSON.stringify({ action, jobId: "job-a", ...extra }) })) };
}
beforeEach(() => {
  vi.clearAllMocks(); browser.connect.mockResolvedValue({ close: browser.close, disconnect: browser.disconnect, pages: async () => [{ ...browser.page, url: () => "https://web.shanbay.com" }] });
  browser.close.mockResolvedValue(undefined); browser.page.cookies.mockResolvedValue([]);
  shanbay.chunk.mockResolvedValue({ words: [], next_cursor: null });
});
describe("isolated remote import job lifecycle", () => {
  it("returns one pending chunk for retries and simultaneous fetches", async () => {
    const h = harness(); const replies = await Promise.all([h.call("chunk"), h.call("chunk")]);
    const [a, b] = await Promise.all(replies.map(r => r.json()));
    expect(a.chunkId).toBe(b.chunkId); expect(shanbay.chunk).toHaveBeenCalledTimes(1);
    expect(h.value().processed).toBe(0); expect(browser.close).not.toHaveBeenCalled();
  });
  it("rejects another job id without connecting to any browser", async () => {
    const h = harness(); expect((await h.call("cancel", { jobId: "job-b" })).status).toBe(404); expect(browser.connect).not.toHaveBeenCalled();
  });
  it("closes only after the final chunk is acknowledged; duplicate ack is harmless", async () => {
    const h = harness(); const chunk = await (await h.call("chunk")).json();
    expect((await h.call("ack", { chunkId: "wrong", added: 0, existing: 0 })).status).toBe(409);
    await h.call("ack", { chunkId: chunk.chunkId, added: 0, existing: 0 });
    expect(h.value().state).toBe("completed"); expect(h.value().sessionId).toBeNull(); expect(browser.close).toHaveBeenCalledTimes(1);
    await h.call("ack", { chunkId: chunk.chunkId, added: 0, existing: 0 }); expect(browser.close).toHaveBeenCalledTimes(1);
  });
  it("destroys sessions on cancellation and alarm expiry", async () => {
    const h = harness(); await h.call("cancel"); expect(h.value().state).toBe("cancelled"); expect(h.value().pending).toBeUndefined();
    const expired = harness(); await expired.instance.alarm(); expect(expired.value().state).toBe("expired"); expect(browser.close).toHaveBeenCalledTimes(2);
  });
  it("retries final cleanup without fetching a book again after close fails", async () => {
    const h = harness(); const chunk = await (await h.call("chunk")).json();
    browser.close.mockRejectedValueOnce(new Error("Temporary close failure"));
    expect((await h.call("ack", { chunkId: chunk.chunkId, added: 0, existing: 0 })).status).toBe(503);
    expect(h.value().completePending).toBe(true);
    const result = await (await h.call("chunk")).json(); expect(result.state).toBe("completed"); expect(shanbay.chunk).toHaveBeenCalledTimes(1);
  });
});
