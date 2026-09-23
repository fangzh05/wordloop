import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { PlayIcon, ReplayIcon } from "../components/Icons.js";
import { FocusButton } from "../components/FocusButton.js";
import { subscribeToApp } from "../mcpBridge.js";
import { gradeExactRecall } from "../grading/deterministic.js";
import { loadDictionaryPronunciationAudio, playPronunciation } from "../pronunciation/audio.js";

const legacyPayloadSchema = z.object({
  widget: z.literal("dictation"),
  mode: z.literal("text").optional(),
  text: z.string().min(1),
  title: z.string().min(1).optional(),
  phase: z.literal("dictation").optional(),
  current_index: z.number().int().min(0).optional(),
}).strict();
const wordPayloadSchema = z.object({
  widget: z.literal("dictation"),
  mode: z.literal("words"),
  words: z.array(z.string().trim().min(1)).min(5).max(7),
  title: z.string().min(1).optional(),
  phase: z.literal("dictation").optional(),
  current_index: z.number().int().min(0).max(7).optional(),
}).strict();
const payloadSchema = z.union([wordPayloadSchema, legacyPayloadSchema]);
type DictationPayload = z.infer<typeof payloadSchema>;
type WordResult = { answer: string; target: string; kind: "correct" | "near" | "wrong" };

function payloadSignature(payload: DictationPayload): string {
  return payload.mode === "words"
    ? JSON.stringify(["words", payload.words, payload.title ?? "单词听写", payload.current_index ?? 0])
    : JSON.stringify(["text", payload.text, payload.title ?? "听写", payload.current_index ?? 0]);
}

export function DictationWidget(): React.JSX.Element {
  const [payload, setPayload] = useState<DictationPayload | null>(null);
  const [rate, setRate] = useState(1);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<WordResult | null>(null);
  const [dictionaryAudio, setDictionaryAudio] = useState<Record<string, string>>({});
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingToolResult = useRef<string | null>(null);
  const speechAvailable = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  useEffect(() => subscribeToApp((event) => {
    if (event.type !== "toolinput" && event.type !== "toolresult") return;
    const candidate = event.type === "toolinput" ? { widget: "dictation", ...event.value } : event.value.structuredContent;
    const parsed = payloadSchema.safeParse(candidate);
    if (!parsed.success) return;
    const signature = payloadSignature(parsed.data);
    if (event.type === "toolinput") pendingToolResult.current = signature;
    else {
      const duplicatesToolInput = pendingToolResult.current === signature;
      pendingToolResult.current = null;
      if (duplicatesToolInput) return;
    }
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    setPayload(parsed.data);
    setCurrentIndex(parsed.data.mode === "words" ? parsed.data.current_index ?? 0 : 0);
    setAnswer("");
    setResult(null);
    setShowTranscript(false);
  }), []);

  useEffect(() => {
    let cancelled = false;
    setDictionaryAudio({});
    if (!payload || payload.mode !== "words") return () => { cancelled = true; };

    void loadDictionaryPronunciationAudio(payload.words)
      .then((audio) => {
        if (cancelled) return;
        setDictionaryAudio(audio);
      })
      .catch(() => {
        if (cancelled) return;
        setDictionaryAudio({});
      });
    return () => { cancelled = true; };
  }, [payload]);

  useEffect(() => () => {
    if (advanceTimer.current !== null) clearTimeout(advanceTimer.current);
  }, []);

  function play(): void {
    if (!payload) return;
    if (payload.mode === "words") {
      const word = payload.words[currentIndex];
      if (!word) return;
      playPronunciation(word, dictionaryAudio[word], () => setPlaying(true), () => setPlaying(false));
      return;
    }
    if (!speechAvailable) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(payload.text);
    utterance.lang = "en-US";
    utterance.rate = rate;
    utterance.onstart = () => setPlaying(true);
    utterance.onend = () => setPlaying(false);
    utterance.onerror = () => setPlaying(false);
    window.speechSynthesis.speak(utterance);
  }

function submitWord(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!payload || payload.mode !== "words" || result) return;
    const target = payload.words[currentIndex];
    if (!target || !answer.trim()) return;
    const grade = gradeExactRecall(answer, target);
    const kind = grade.is_correct ? grade.error_layer === "spelling" ? "near" : "correct" : "wrong";
    setResult({ answer, target, kind });
    advanceTimer.current = setTimeout(() => {
      setCurrentIndex((index) => index + 1);
      setAnswer("");
      setResult(null);
      advanceTimer.current = null;
    }, 1500);
  }

  if (payload?.mode === "words") {
    const word = payload.words[currentIndex];
    if (!word) return <section className="widget-card dictation-card" aria-labelledby="dictation-title">
      <header className="widget-header compact-header"><div><span className="eyebrow">听力练习</span><h1 id="dictation-title">本轮听写完成</h1></div><FocusButton /></header>
    </section>;

    const dictionaryAvailable = Boolean(dictionaryAudio[word]);
    return <section className="widget-card dictation-card" aria-labelledby="dictation-title">
      <header className="widget-header compact-header"><div><span className="eyebrow">单词听写</span><h1 id="dictation-title">听写</h1><p>{currentIndex + 1} / {payload.words.length}</p></div><FocusButton /></header>
      <div className="dictation-controls">
        <Button className="round-play" onClick={play} disabled={!dictionaryAvailable && !speechAvailable}>
          <PlayIcon className="button-icon" /> {playing ? "正在播放" : "播放 / 重播"}
        </Button>
      </div>
      <form className="word-dictation-form" onSubmit={submitWord}>
        <input
          id="dictation-word-answer"
          aria-label="听写答案"
          className="answer-input"
          type="text"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={result !== null}
        />
        <Button type="submit" disabled={!answer.trim() || result !== null}>提交</Button>
      </form>
      {result ? <p className="dictation-result" aria-live="polite">
        {result.kind === "correct" ? `你的答案：${result.answer} · ✓ 正确`
          : result.kind === "near" ? `拼写：${result.answer} → ${result.target}`
            : `你的答案：${result.answer} · 正确答案：${result.target}`}
      </p> : null}
    </section>;
  }

  return <section className="widget-card dictation-card" aria-labelledby="dictation-title">
    <header className="widget-header compact-header"><div><span className="eyebrow">听力练习</span><h1 id="dictation-title">{payload?.title ?? "听写"}</h1><p>原文默认隐藏，需要时再显示。</p></div><FocusButton /></header>
    <div className="dictation-controls">
      <Button className="round-play" onClick={play} disabled={!payload || !speechAvailable}><PlayIcon className="button-icon" /> {playing ? "正在播放" : "播放"}</Button>
      <Button className="secondary" onClick={play} disabled={!payload || !speechAvailable}><ReplayIcon className="button-icon" /> 重播</Button>
    </div>
    {!speechAvailable ? <p className="error-text">当前设备无法播放</p> : null}
    <div className="divider" />
    <fieldset className="speed-control">
      <legend>速度</legend>
      {[0.75, 1, 1.25].map((option) => <button type="button" key={option} className={rate === option ? "selected" : ""} onClick={() => setRate(option)}>{option}×</button>)}
    </fieldset>
    <Button className="secondary transcript-button" onClick={() => setShowTranscript((value) => !value)} disabled={!payload}>
      {showTranscript ? "隐藏原文" : "显示原文"}
    </Button>
    {showTranscript && payload ? <p className="transcript" aria-live="polite">{payload.text}</p> : null}
  </section>;
}
