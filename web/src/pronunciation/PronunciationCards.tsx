import { useEffect, useState } from "react";
import { z } from "zod";
import { subscribeToApp } from "../mcpBridge.js";
import { PlayIcon } from "../components/Icons.js";
import { FocusButton } from "../components/FocusButton.js";
import {
  loadDictionaryPronunciationAudio,
  playPronunciation,
  pronunciationButtonLabel,
  selectEnglishVoice,
} from "./audio.js";

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
  const [englishVoiceAvailable, setEnglishVoiceAvailable] = useState(false);
  const [dictionaryAudio, setDictionaryAudio] = useState<Record<string, string>>({});
  const [dictionaryReady, setDictionaryReady] = useState(false);
  const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  useEffect(() => {
    if (!speechAvailable) return;
    const synthesis = window.speechSynthesis;
    const updateVoiceAvailability = (): void => {
      setEnglishVoiceAvailable(selectEnglishVoice(synthesis.getVoices()) !== null);
    };
    updateVoiceAvailability();
    synthesis.addEventListener("voiceschanged", updateVoiceAvailability);
    return () => synthesis.removeEventListener("voiceschanged", updateVoiceAvailability);
  }, [speechAvailable]);

  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput" ? { widget: "pronunciation", ...event.value } : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (parsed.success) setWords(parsed.data.words);
  }), []);

  useEffect(() => {
    let cancelled = false;
    if (words.length === 0) {
      setDictionaryAudio({});
      setDictionaryReady(true);
      return () => { cancelled = true; };
    }

    setDictionaryReady(false);
    void loadDictionaryPronunciationAudio(words.map((item) => item.word))
      .then((audio) => {
        if (!cancelled) setDictionaryAudio(audio);
      })
      .catch(() => {
        if (!cancelled) setDictionaryAudio({});
      })
      .finally(() => {
        if (!cancelled) setDictionaryReady(true);
      });
    return () => { cancelled = true; };
  }, [words]);

  function play(word: string): void {
    playPronunciation(
      word,
      dictionaryAudio[word],
      () => setPlaying(word),
      () => setPlaying(null),
    );
  }

  const hasDictionaryAudio = Object.keys(dictionaryAudio).length > 0;

  return <section className="widget-card" aria-labelledby="pronunciation-title">
    <header className="widget-header compact-header"><div><span className="eyebrow">先听再读</span><h1 id="pronunciation-title">发音</h1><p>美式英语 · 点击播放</p></div><FocusButton /></header>
    <div className="pronunciation-list">
      {words.map((item) => {
        const dictionaryAudioAvailable = Boolean(dictionaryAudio[item.word]);
        const speechPlaybackAvailable = speechAvailable && englishVoiceAvailable;
        const playable = dictionaryAudioAvailable || speechPlaybackAvailable;
        return <div className="pronunciation-row" key={item.word}>
          <div className="pronunciation-copy">
            <div className="pronunciation-heading"><strong>{item.word}</strong>{item.part_of_speech ? <span className="part-of-speech">{item.part_of_speech}</span> : null}</div>
            <span className="ipa">{item.ipa}</span>
            {item.meaning_zh ? <span className="meaning-zh">{item.meaning_zh}</span> : null}
          </div>
          <button className="play-button" type="button" onClick={() => play(item.word)} disabled={!dictionaryReady || !playable} aria-label={`播放 ${item.word}`}>
            <span className="play-icon"><PlayIcon /></span>{pronunciationButtonLabel(dictionaryAudioAvailable, speechPlaybackAvailable, dictionaryReady, playing === item.word)}
          </button>
        </div>;
      })}
    </div>
    {hasDictionaryAudio ? <div className="dictionary-attribution" aria-label="Pronunciation audio by Merriam-Webster">
      <img src="https://dictionaryapi.com/images/info/branding-guidelines/MWLogo_LightBG_120x120_2x.png" width="50" height="50" alt="Merriam-Webster" />
      <span>发音来自 Merriam-Webster's Learner's Dictionary</span>
    </div> : null}
  </section>;
}
