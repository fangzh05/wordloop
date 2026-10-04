import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureRuntimeEnv, resetDatabaseForTests, withUserIdentity } from "../server/db.js";
import { verifyBridgeRequest } from "../shared/importBridgeAuth.js";
import { handleShanbayImportRequest } from "../server/shanbayImportApi.js";
const mocks = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock("../server/integrations/shanbay/importer.js", () => ({ persistShanbayBook: mocks.persist }));
const secret = "test-secret-only-for-the-backend-bridge";
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";
const req = (action: string, input: unknown = {}) => new Request(`https://wordloop.test/api/web/shanbay-import/${action}`, { method: "POST", body: JSON.stringify(input) });
beforeEach(() => {
  resetDatabaseForTests(); vi.restoreAllMocks(); mocks.persist.mockReset();
  configureRuntimeEnv({ SHANBAY_IMPORT_WORKER_URL: "https://bridge.test", SHANBAY_IMPORT_BRIDGE_SECRET: secret });
});
describe("personal Shanbay import API", () => {
  it("signs concurrent requests with their verified user identities", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const body = String(init?.body); const headers = new Headers(init?.headers);
      expect(await verifyBridgeRequest(secret, headers.get("x-bridge-time")!, body, headers.get("x-bridge-signature")!)).toBe(true);
      const input = JSON.parse(body); seen.push(input.userId);
      return Response.json({ jobId, state: "waiting_login" });
    });
    const responses = await Promise.all([withUserIdentity(first, () => handleShanbayImportRequest(req("start"))), withUserIdentity(second, () => handleShanbayImportRequest(req("start")))]);
    expect(responses.map(r => r.status)).toEqual([200, 200]); expect(seen.sort()).toEqual([first, second]);
  });
  it("rejects browser-supplied user identities and cookie values", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const input of [{ userId: second }, { cookie: "private" }, { jobId, sessionId: "other-session" }]) {
      expect((await withUserIdentity(first, () => handleShanbayImportRequest(req("start", input)))).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never advances the remote cursor before a successful database write", async () => {
    const actions: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const input = JSON.parse(String(init?.body)); actions.push(input.action);
      return Response.json(input.action === "chunk" ? { jobId, book: { id: "book", name: "My book" }, chunkId: "pending-chunk", words: [] } : { jobId, state: "completed", processed: 0 });
    });
    mocks.persist.mockRejectedValueOnce(new Error("Database failure")).mockResolvedValue({ new: 0, existing: 0 });
    const run = () => withUserIdentity(first, () => handleShanbayImportRequest(req("chunk", { jobId })));
    expect((await run()).status).toBe(503); expect(actions).toEqual(["chunk"]);
    expect((await run()).status).toBe(200); expect(actions).toEqual(["chunk", "chunk", "ack"]);
  });
  it("shows rate limits without forwarding browser diagnostics or credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "BROWSER_RATE_LIMITED", detail: "secret-browser-url" }, { status: 503 }));
    const response = await withUserIdentity(first, () => handleShanbayImportRequest(req("start")));
    const text = await response.text(); expect(text).toContain("BROWSER_RATE_LIMITED"); expect(text).not.toContain("secret-browser-url");
  });
});
