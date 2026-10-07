import { afterEach, describe, expect, it, vi } from "vitest";
import { getBootstrap, postAction, WEB_REQUEST_TIMEOUT_MS } from "../web/src/standalone/apiClient.js";
import { runForegroundRequest } from "../web/src/standalone/StandaloneApp.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("standalone request deadline", () => {
  it("releases the action lock when a fetch never settles and permits another request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "test" });
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(new Response(JSON.stringify({ screen: "done", state: {} })));
    vi.stubGlobal("fetch", fetchMock);
    const lock = { current: false };
    const first = runForegroundRequest(lock, () => postAction({ action: "lesson_next", expected_revision: "rev" }));
    const rejection = expect(first).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(WEB_REQUEST_TIMEOUT_MS);
    await rejection;
    expect(lock.current).toBe(false);
    await expect(runForegroundRequest(lock, () => getBootstrap())).resolves.toMatchObject({ started: true, result: { screen: "done" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("also bounds a response whose JSON body stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", { getItem: () => "test" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, json: () => new Promise(() => undefined) }));
    const result = expect(getBootstrap()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(WEB_REQUEST_TIMEOUT_MS);
    await result;
  });
});
