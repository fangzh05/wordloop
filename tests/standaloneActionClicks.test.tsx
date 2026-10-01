import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const harness = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, post: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = typeof initial === "function" ? initial() : initial;
    return [harness.values[index], (value: unknown) => { harness.values[index] = typeof value === "function" ? value(harness.values[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = { current: initial };
    return harness.values[index];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
}));
vi.mock("../web/src/standalone/apiClient.js", async (original) => ({ ...await original<typeof import("../web/src/standalone/apiClient.js")>(), postAction: harness.post }));
import StandaloneApp from "../web/src/standalone/StandaloneApp.js";

function find(root: unknown, predicate: (node: ReactElement<Record<string, any>>) => boolean): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(root)) { for (const child of root) { const found = find(child, predicate); if (found) return found; } }
  if (!root || typeof root !== "object" || !("props" in root)) return;
  const node = root as ReactElement<Record<string, any>>;
  return predicate(node) ? node : find(node.props.children, predicate);
}

describe("standalone action click handlers", () => {
  beforeEach(() => {
    harness.values = ["study", "study", "system", false, null, "test", "", {
      screen: "lesson", session_revision: "revision", state: {
        widget: "lesson", phase: "lesson_feedback", current_word: "quarantine", current_index: 3,
        flow: { lesson_words: ["a", "b", "c", "quarantine"] },
        payload: { mode: "feedback", feedback: { is_correct: false, reveal_answer: true }, navigation: { action: "round_complete" } },
      }, pending_consolidation: { label: "长难句英译中" },
    }, "ready", null];
    harness.cursor = 0;
    harness.post.mockReset().mockResolvedValue({ screen: "done", state: {}, session_revision: "next" });
    vi.stubGlobal("window", { location: { hash: "#study" }, history: { pushState: vi.fn() } });
  });
  it("sends lesson_next when completing the final feedback", async () => {
    const tree = StandaloneApp();
    const button = find(tree, node => node.props.children === "完成本轮并继续");
    expect(button).toBeDefined();
    button!.props.onClick();
    await vi.waitFor(() => expect(harness.post).toHaveBeenCalledWith({ action: "lesson_next", expected_revision: "revision" }));
  });
  it("sends consolidation_start from the Today screen", async () => {
    harness.values[0] = "dashboard"; harness.values[1] = "today";
    const tree = StandaloneApp();
    const today = find(tree, node => typeof node.props.onStartConsolidation === "function");
    expect(today).toBeDefined();
    today!.props.onStartConsolidation();
    await vi.waitFor(() => expect(harness.post).toHaveBeenCalledWith({ action: "consolidation_start", expected_revision: "revision" }));
  });
  it("does not render vocabulary feedback as finished consolidation feedback", () => {
    const view = harness.values[7] as any;
    view.state.phase = "lesson_complete";
    Object.assign(view.state.payload, { consolidation: true, consolidation_kind: "translation", consolidation_status: "pending" });
    const tree = StandaloneApp();
    expect(find(tree, node => node.props.children === "继续学习")).toBeUndefined();
    expect(find(tree, node => node.props.children === "做一道，约 2 分钟")).toBeDefined();
  });
});
