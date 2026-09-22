import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getMerriamWebsterApiKey } from "../db.js";
import { safeTool } from "./helpers.js";

const pronunciationAudioInput = z.object({
  words: z.array(z.string().trim().min(1).max(100)).min(1).max(7),
});

type MerriamEntry = {
  meta?: { id?: string; stems?: string[] };
  hwi?: {
    prs?: Array<{ sound?: { audio?: string } }>;
  };
};

const MAX_PRONUNCIATION_CACHE_ENTRIES = 1024;
const MAX_UNCACHED_LOOKUPS_PER_MINUTE = 60;
const LOOKUP_WINDOW_MS = 60_000;
const pronunciationAudioCache = new Map<string, Promise<string | null>>();
let lookupWindowStart: number | null = null;
let uncachedLookupCount = 0;

function normalizeWord(value: string): string {
  return value.trim().toLowerCase();
}

export function buildMerriamWebsterAudioUrl(audio: string): string {
  const normalized = audio.trim();
  let directory = normalized.slice(0, 1).toLowerCase();
  if (normalized.toLowerCase().startsWith("bix")) directory = "bix";
  else if (normalized.toLowerCase().startsWith("gg")) directory = "gg";
  else if (!/^[a-z]/i.test(normalized)) directory = "number";
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${directory}/${normalized}.mp3`;
}

function entryAudio(entry: MerriamEntry): string | null {
  for (const pronunciation of entry.hwi?.prs ?? []) {
    const audio = pronunciation.sound?.audio?.trim();
    if (audio) return audio;
  }
  return null;
}

function isExactEntry(entry: MerriamEntry, word: string): boolean {
  const normalized = normalizeWord(word);
  const id = entry.meta?.id?.split(":")[0];
  if (id && normalizeWord(id) === normalized) return true;
  return (entry.meta?.stems ?? []).some((stem) => normalizeWord(stem) === normalized);
}

function isMerriamEntry(value: unknown): value is MerriamEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function lookupAudioUrl(word: string, key: string): Promise<string | null> {
  const endpoint = `https://www.dictionaryapi.com/api/v3/references/learners/json/${encodeURIComponent(word)}?key=${encodeURIComponent(key)}`;
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Merriam-Webster lookup failed with HTTP ${response.status}.`);

  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) return null;
  const entry = payload.filter(isMerriamEntry).find((candidate) => isExactEntry(candidate, word));
  if (!entry) return null;
  const audio = entryAudio(entry);
  return audio ? buildMerriamWebsterAudioUrl(audio) : null;
}

function uniqueDisplayWords(words: string[]): string[] {
  const unique = new Map<string, string>();
  for (const word of words) {
    const displayWord = word.trim();
    const cacheKey = normalizeWord(displayWord);
    if (!cacheKey || unique.has(cacheKey)) continue;
    unique.set(cacheKey, displayWord);
  }
  return [...unique.values()];
}

function canStartUncachedLookup(): boolean {
  const now = Date.now();
  if (lookupWindowStart === null || now - lookupWindowStart >= LOOKUP_WINDOW_MS) {
    lookupWindowStart = now;
    uncachedLookupCount = 0;
  }
  if (uncachedLookupCount >= MAX_UNCACHED_LOOKUPS_PER_MINUTE) return false;
  uncachedLookupCount += 1;
  return true;
}

function evictOldestCacheEntry(): void {
  while (pronunciationAudioCache.size >= MAX_PRONUNCIATION_CACHE_ENTRIES) {
    const oldest = pronunciationAudioCache.keys().next().value;
    if (oldest === undefined) return;
    pronunciationAudioCache.delete(oldest);
  }
}

function lookupCachedAudioUrl(word: string, key: string): Promise<string | null> {
  const cacheKey = normalizeWord(word);
  const cached = pronunciationAudioCache.get(cacheKey);
  if (cached) return cached;

  // This is a quota guard, not authentication. It only limits uncached work.
  if (!canStartUncachedLookup()) return Promise.resolve(null);

  evictOldestCacheEntry();
  const pendingLookup = lookupAudioUrl(word.trim(), key);
  const trackedLookup = pendingLookup.catch((error: unknown) => {
    if (pronunciationAudioCache.get(cacheKey) === trackedLookup) {
      pronunciationAudioCache.delete(cacheKey);
    }
    throw error;
  });
  pronunciationAudioCache.set(cacheKey, trackedLookup);
  return trackedLookup;
}

/** Test-only reset for module-level cache and quota state. */
export function resetPronunciationAudioStateForTests(): void {
  pronunciationAudioCache.clear();
  lookupWindowStart = null;
  uncachedLookupCount = 0;
}

export async function getPronunciationAudio(words: string[]): Promise<{
  provider: "merriam-webster-learners" | "speech-synthesis";
  available: boolean;
  words: Array<{ word: string; audio_url: string | null }>;
}> {
  const uniqueWords = uniqueDisplayWords(words);
  const key = getMerriamWebsterApiKey();
  if (!key) {
    return {
      provider: "speech-synthesis",
      available: false,
      words: uniqueWords.map((word) => ({ word, audio_url: null })),
    };
  }

  const resolved = await Promise.all(uniqueWords.map(async (word) => {
    try {
      return { word, audio_url: await lookupCachedAudioUrl(word, key) };
    } catch (error) {
      console.warn("Merriam-Webster pronunciation lookup failed", word, error instanceof Error ? error.message : "unknown error");
      return { word, audio_url: null };
    }
  }));

  return {
    provider: "merriam-webster-learners",
    available: resolved.some((entry) => entry.audio_url !== null),
    words: resolved,
  };
}

export function registerGetPronunciationAudioTool(server: McpServer): void {
  registerAppTool(server, "get_pronunciation_audio", {
    title: "Get pronunciation audio",
    description: "Widget-only pronunciation lookup. Returns Merriam-Webster Learner's Dictionary audio URLs when configured; otherwise Widgets fall back to local English speech synthesis.",
    inputSchema: pronunciationAudioInput,
    // App visibility is not authentication. Cache and rate limiting reduce quota abuse but do not replace authentication.
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => safeTool(() => getPronunciationAudio(input.words)));
}
