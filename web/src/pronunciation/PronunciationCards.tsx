import { useEffect, useState } from "react";
import { z } from "zod";
import { subscribeToApp } from "../mcpBridge.js";
import { PlayIcon } from "../components/Icons.js";

const payloadSchema = z.object({
  widget: z.literal("pronunciation"),
  words: z.array(z.object({
    word: z.string(),
    ipa: z.string(),
    part_of_speech: z.string().optional(),
    meaning_zh: z.string().optional(),
  })).min(1).max(7),
});
type PronunciationWord = z.infer<typeof payloadSchema>["words"][number];

export function PronunciationCards(): React.JSX.Element {
  const [words, setWords] = useState<PronunciationWord[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput" ? { widget: "pronunciation", ...event.value } : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (parsed.success) setWords(parsed.data.words);
  }), []);

  function play(word: string): void {
    if (!speechAvailable) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    utterance.onstart = () => setPlaying(word);
    utterance.onend = () => setPlaying(null);
    utterance.onerror = () => setPlaying(null);
    window.speechSynthesis.speak(utterance);
  }

  return <section className="widget-card" aria-labelledby="pronunciation-title">
    <header className="widget-header"><span className="eyebrow">Listen first</span><h1 id="pronunciation-title">Pronunciation</h1><p>American English · tap a word to hear it</p></header>
    <div className="pronunciation-list">
      {words.map((item) => <div className="pronunciation-row" key={item.word}>
        <div className="pronunciation-copy">
          <div className="pronunciation-heading"><strong>{item.word}</strong>{item.part_of_speech ? <span className="part-of-speech">{item.part_of_speech}</span> : null}</div>
          <span className="ipa">{item.ipa}</span>
          {item.meaning_zh ? <span className="meaning-zh">{item.meaning_zh}</span> : null}
        </div>
        <button className="play-button" type="button" onClick={() => play(item.word)} disabled={!speechAvailable} aria-label={`Play ${item.word}`}>
          <span className="play-icon"><PlayIcon /></span>{speechAvailable ? (playing === item.word ? "Playing" : "Play") : "Audio unavailable"}
        </button>
      </div>)}
    </div>
  </section>;
}
