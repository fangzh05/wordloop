import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMocks = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  connect: vi.fn(),
  getHostCapabilities: vi.fn(),
  getHostContext: vi.fn(),
  callServerTool: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class FakeApp {
    addEventListener = appMocks.addEventListener;

    async connect(...args: unknown[]): Promise<void> {
      await appMocks.connect(...args);
    }

    getHostCapabilities(): unknown {
      return appMocks.getHostCapabilities();
    }

    getHostContext(): unknown {
      return appMocks.getHostContext();
    }

    callServerTool(...args: unknown[]): Promise<CallToolResult> {
      return appMocks.callServerTool(...args) as Promise<CallToolResult>;
    }
  },
}));

import { callServerTool } from "../web/src/mcpBridge.js";

const originalWindow = globalThis.window;

beforeEach(() => {
  appMocks.connect.mockReset().mockResolvedValue(undefined);
  appMocks.getHostCapabilities.mockReset().mockReturnValue({ serverTools: {} });
  appMocks.getHostContext.mockReset().mockReturnValue(undefined);
  appMocks.callServerTool.mockReset();
  globalThis.window = {} as Window & typeof globalThis;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

describe("widget server-tool bridge", () => {
  it("propagates app server-tool errors without invoking the legacy fallback", async () => {
    const serverError = new Error("Invalid input for tool record_review_submission: direction is required");
    appMocks.callServerTool.mockRejectedValue(serverError);
    const legacyCallTool = vi.fn().mockResolvedValue({ content: [] });
    globalThis.window = { openai: { callTool: legacyCallTool } } as unknown as Window & typeof globalThis;

    await expect(callServerTool("record_review_submission", { word: "recur" })).rejects.toBe(serverError);
    expect(appMocks.callServerTool).toHaveBeenCalledWith({
      name: "record_review_submission",
      arguments: { word: "recur" },
    });
    expect(legacyCallTool).not.toHaveBeenCalled();
  });

  it("keeps the legacy fallback when the host has no server-tools capability", async () => {
    appMocks.getHostCapabilities.mockReturnValue({});
    const legacyResult: CallToolResult = { content: [{ type: "text", text: "legacy" }] };
    const legacyCallTool = vi.fn().mockResolvedValue(legacyResult);
    globalThis.window = { openai: { callTool: legacyCallTool } } as unknown as Window & typeof globalThis;

    await expect(callServerTool("record_attempt", { word: "recur" })).resolves.toBe(legacyResult);
    expect(legacyCallTool).toHaveBeenCalledWith("record_attempt", { word: "recur" });
    expect(appMocks.callServerTool).not.toHaveBeenCalled();
  });

  it("does not reinterpret a connection failure as legacy compatibility", async () => {
    vi.resetModules();
    const connectionError = new Error("MCP connection failed");
    appMocks.connect.mockReset().mockRejectedValue(connectionError);
    const legacyCallTool = vi.fn().mockResolvedValue({ content: [] });
    globalThis.window = { openai: { callTool: legacyCallTool } } as unknown as Window & typeof globalThis;

    const freshBridge = await import("../web/src/mcpBridge.js");
    await expect(freshBridge.callServerTool("record_attempt", { word: "recur" })).rejects.toBe(connectionError);
    expect(legacyCallTool).not.toHaveBeenCalled();
  });
});
