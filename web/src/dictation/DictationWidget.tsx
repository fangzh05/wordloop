import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { PlayIcon, ReplayIcon } from "../components/Icons.js";
import { subscribeToApp } from "../mcpBridge.js";

const payloadSchema = z.object({ widget: z.literal("dictation"), text: z.string().min(1), title: z.string().min(1) });

export function DictationWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<z.infer<typeof payloadSchema> | null>(null);
  const [rate, setRate] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playing, setPlaying] = useState(false);
  const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput" ? { widget: "dictation", ...event.value } : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (parsed.success) setPayload(parsed.data);
  }), []);

  function play(): void {
    if (!payload || !speechAvailable) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(payload.text);
    utterance.lang = "en-US";
    utterance.rate = rate;
    utterance.onstart = () => setPlaying(true);
    utterance.onend = () => setPlaying(false);
    utterance.onerror = () => setPlaying(false);
    window.speechSynthesis.speak(utterance);
  }

  return <section className="widget-card dictation-card" aria-labelledby="dictation-title">
    <header className="widget-header"><span className="eyebrow">Listening practice</span><h1 id="dictation-title">{payload?.title ?? "Dictation"}</h1><p>The transcript stays hidden until you reveal it.</p></header>
    <div className="dictation-controls">
      <Button className="round-play" onClick={play} disabled={!payload || !speechAvailable}><PlayIcon className="button-icon" /> {playing ? "Playing" : "Play"}</Button>
      <Button className="secondary" onClick={play} disabled={!payload || !speechAvailable}><ReplayIcon className="button-icon" /> Replay</Button>
    </div>
    {!speechAvailable ? <p className="error-text">Audio unavailable</p> : null}
    <div className="divider" />
    <fieldset className="speed-control">
      <legend>Speed</legend>
      {[0.75, 1, 1.25].map((option) => <button type="button" key={option} className={rate === option ? "selected" : ""} onClick={() => setRate(option)}>{option}×</button>)}
    </fieldset>
    <Button className="secondary transcript-button" onClick={() => setShowTranscript((value) => !value)} disabled={!payload}>
      {showTranscript ? "Hide transcript" : "Show transcript"}
    </Button>
    {showTranscript && payload ? <p className="transcript" aria-live="polite">{payload.text}</p> : null}
  </section>;
}
