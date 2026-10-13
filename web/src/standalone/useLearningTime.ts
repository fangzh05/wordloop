import { useEffect, useRef } from "react";
import { LearningTimeTracker, type TimeContext } from "../learningTimeTracker.js";
import { postAction } from "./apiClient.js";
export function useLearningTime(context: TimeContext | undefined, visible: boolean, busy: boolean, feedback: boolean) {
  const holder = useRef<LearningTimeTracker | null>(null);
  const feedbackRef = useRef(feedback); feedbackRef.current = feedback;
  const waiting = useRef(busy); waiting.current = busy;
  const key = context ? `${context.session_id}:${context.phase}:${context.index}:${context.retry}:${context.stage}:${context.phase_started_at}:${context.consolidation}:${context.consolidation_status}:${feedback}` : "";
  useEffect(() => {
    const activeConsolidation = context?.consolidation === true && (context.consolidation_status === "exercise" || context.consolidation_status === "feedback");
    if (!context || !visible || (context.phase.endsWith("complete") && !feedback && !activeConsolidation)) { holder.current = null; return; }
    const stage = feedback && context.scope === "review" ? "feedback" : context.stage;
    const tracker = new LearningTimeTracker({ ...context, stage }, observation => postAction({ action: "record_learning_time", observation, expected_revision: null }));
    holder.current = tracker; tracker.wait(waiting.current);
    const activity = () => tracker.activity();
    const visibility = () => { tracker.visible(document.visibilityState === "visible"); void tracker.flush(); };
    for (const event of ["pointerdown", "keydown", "scroll", "touchstart"]) window.addEventListener(event, activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    const interval = window.setInterval(() => { if (!waiting.current && document.visibilityState === "visible") void tracker.flush(); }, 15000);
    void tracker.flush();
    return () => { void tracker.flush(); window.clearInterval(interval); for (const event of ["pointerdown", "keydown", "scroll", "touchstart"]) window.removeEventListener(event, activity); document.removeEventListener("visibilitychange", visibility); };
  }, [key, visible]);
  useEffect(() => { holder.current?.wait(busy); }, [busy]);
  return async (finalize = true) => {
    const tracker = holder.current;
    if (!tracker) return false;
    tracker.wait(true);
    let recorded = await tracker.flush(finalize);
    if (finalize && !tracker.isFinished) recorded = await tracker.flush(true);
    return recorded;
  };
}
