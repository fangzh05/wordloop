import { z } from "zod";
import { callServerTool, toolResultData } from "../mcpBridge.js";

const pronunciationAudioResultSchema = z.object({
  provider: z.enum(["merriam-webster-learners", "speech-synthesis"]),
  available: z.boolean(),
  words: z.array(z.object({
    word: z.string(),
    audio_url: z.string().url().nullable(),
  })),
});

export function selectEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return voices.find((voice) => voice.lang.toLowerCase() === "en-us")
    ?? voices.find((voice) => voice.lang.toLowerCase().startsWith("en-"))
    ?? null;
}

export async function loadDictionaryPronunciationAudio(words: string[]): Promise<Record<string, string>> {
  const uniqueWords = [...new Set(words.map((word) => word.trim()).filter(Boolean))];
  if (uniqueWords.length === 0) return {};

  const result = await callServerTool("get_pronunciation_audio", { words: uniqueWords });
  const parsed = pronunciationAudioResultSchema.safeParse(toolResultData(result));
  if (!parsed.success) return {};

  return Object.fromEntries(
    parsed.data.words
      .filter((entry): entry is { word: string; audio_url: string } => typeof entry.audio_url === "string")
      .map((entry) => [entry.word, entry.audio_url]),
  );
}

function playSpeechFallback(word: string, onStart: () => void, onEnd: () => void): void {
  if (typeof window === "undefined"
    || !("speechSynthesis" in window)
    || !("SpeechSynthesisUtterance" in window)) {
    onEnd();
    return;
  }

  const voice = selectEnglishVoice(window.speechSynthesis.getVoices());
  if (!voice) {
    onEnd();
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.9;
  utterance.onstart = onStart;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  window.speechSynthesis.speak(utterance);
}

export function playPronunciation(
  word: string,
  dictionaryAudioUrl: string | undefined,
  onStart: () => void,
  onEnd: () => void,
): void {
  if (!dictionaryAudioUrl || typeof Audio === "undefined") {
    playSpeechFallback(word, onStart, onEnd);
    return;
  }

  window.speechSynthesis?.cancel();
  const audio = new Audio(dictionaryAudioUrl);
  let fallbackStarted = false;
  const fallback = (): void => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    playSpeechFallback(word, onStart, onEnd);
  };

  audio.preload = "auto";
  audio.onplay = onStart;
  audio.onended = onEnd;
  audio.onerror = fallback;
  void audio.play().catch(fallback);
}
