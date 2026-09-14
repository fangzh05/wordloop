import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyHostContext } from "../web/src/mcpBridge.js";

const styles = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

function installDocumentStub() {
  const setProperty = vi.fn();
  const documentElement = { dataset: {} as Record<string, string>, style: { setProperty } };
  vi.stubGlobal("document", { documentElement });
  return { documentElement, setProperty };
}

afterEach(() => vi.unstubAllGlobals());

describe("MCP Apps host context layout", () => {
  it("keeps inline mode at the default layout and clears safe-area values", () => {
    const { documentElement, setProperty } = installDocumentStub();

    applyHostContext({ displayMode: "inline", safeAreaInsets: { top: 59, bottom: 34 } });

    expect(documentElement.dataset.displayMode).toBe("inline");
    expect(setProperty).toHaveBeenCalledWith("--safe-area-top", "59px");
    expect(setProperty).toHaveBeenCalledWith("--safe-area-right", "0px");
    expect(styles).toContain(':root[data-display-mode="fullscreen"] body');
    expect(styles).not.toMatch(/(?:^|\n)body\s*\{[^}]*padding-top/);
  });

  it("applies fullscreen safe-area padding and leaves room for the host close control", () => {
    const { documentElement, setProperty } = installDocumentStub();

    applyHostContext({ displayMode: "fullscreen", safeAreaInsets: { top: 59, right: 8, bottom: 34, left: 0 } });

    expect(documentElement.dataset.displayMode).toBe("fullscreen");
    expect(setProperty).toHaveBeenCalledWith("--safe-area-top", "59px");
    expect(setProperty).toHaveBeenCalledWith("--safe-area-bottom", "34px");
    expect(59 + 12).toBeGreaterThanOrEqual(71);
    expect(34 + 12).toBeGreaterThanOrEqual(46);
    expect(styles).toContain("padding-top: calc(var(--safe-area-top) + 12px)");
    expect(styles).toContain("padding-bottom: calc(var(--safe-area-bottom) + 12px)");
    expect(styles).toContain('padding-right: max(56px, var(--safe-area-right))');
    expect(styles).toContain(':root[data-display-mode="fullscreen"] .widget-card');
  });

  it("updates the display mode when the host changes and restores inline mode", () => {
    const { documentElement } = installDocumentStub();

    applyHostContext({ displayMode: "fullscreen", safeAreaInsets: { top: 59 } });
    expect(documentElement.dataset.displayMode).toBe("fullscreen");

    applyHostContext({ displayMode: "inline" });
    expect(documentElement.dataset.displayMode).toBe("inline");
  });
});
