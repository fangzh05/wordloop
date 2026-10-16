import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const harness = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, post: vi.fn(), flushTime: vi.fn() }));
vi.mock("../web/src/standalone/useLearningTime.js", () => ({ useLearningTime: () => harness.flushTime }));
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
import StandaloneApp, { StandaloneLessonFeedback } from "../web/src/standalone/StandaloneApp.js";

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
    harness.flushTime.mockReset().mockResolvedValue(true);
    vi.stubGlobal("window", { location: { hash: "#study" }, history: { pushState: vi.fn() }, dispatchEvent: vi.fn() });
  });
  it("sends lesson_next when completing the final feedback", async () => {
    const tree = StandaloneApp();
    const button = find(tree, node => node.type === StandaloneLessonFeedback);
    expect(button).toBeDefined();
    button!.props.onNext();
    await vi.waitFor(() => expect(harness.post).toHaveBeenCalledWith({ action: "lesson_next", expected_revision: "revision" }, expect.any(String)));
    await vi.waitFor(() => expect(window.dispatchEvent).toHaveBeenCalled());
    const event = vi.mocked(window.dispatchEvent).mock.calls[0]![0] as CustomEvent;
    expect(event.detail).toMatchObject({ event: "wordloop_interaction_performance", request_id: harness.post.mock.calls[0]![1], operation: "lesson_next", success: true });
    expect(event.detail.client_total_ms).toBeGreaterThanOrEqual(event.detail.action_ms);
    expect(event.detail).not.toHaveProperty("answer");
  });
  it("sends consolidation_start from the Today screen", async () => {
    harness.values[0] = "dashboard"; harness.values[1] = "today";
    const tree = StandaloneApp();
    const today = find(tree, node => typeof node.props.onStartConsolidation === "function");
    expect(today).toBeDefined();
    today!.props.onStartConsolidation();
    await vi.waitFor(() => expect(harness.post).toHaveBeenCalledWith({ action: "consolidation_start", expected_revision: "revision" }, expect.any(String)));
  });
  it("sends the next action and renders its result while time reporting is pending", async () => {
    harness.flushTime.mockImplementation(() => new Promise(() => {}));
    const tree = StandaloneApp();
    const button = find(tree, node => node.type === StandaloneLessonFeedback);
    button!.props.onNext();
    await vi.waitFor(() => expect(harness.post).toHaveBeenCalledWith({ action: "lesson_next", expected_revision: "revision" }, expect.any(String)));
    await vi.waitFor(() => expect(window.dispatchEvent).toHaveBeenCalled());
    expect(harness.values[7]).toMatchObject({ screen: "done", session_revision: "next" });
    expect(harness.flushTime.mock.calls).toEqual([[false], [true]]);
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
