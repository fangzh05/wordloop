import { getShanbayCookie } from "../../db.js";
import { unwrapShanbayPayload } from "./decode.js";
import { mapCurrentBook, mapShanbayWord } from "./mapper.js";
import type { ShanbayBook, ShanbayPage, ShanbaySourceState, ShanbayWord } from "./types.js";

const BASE_URL = "https://apiv3.shanbay.com";
const PAGE_SIZE = 100;
const endpointState: Record<ShanbaySourceState, string> = {
  unlearned: "unlearned_items", learning: "learning_items", simple_learned: "simple_learned_items",
};

export type ShanbayFetch = typeof fetch;

export class ShanbayError extends Error {
  constructor(message: string, readonly code: "auth" | "decode" | "missing_book" | "payload" | "network") { super(message); }
}

function safeError(error: unknown): ShanbayError {
  if (error instanceof ShanbayError) return error;
  return new ShanbayError("Shanbay unavailable.", "network");
}

export class ShanbayClient {
  constructor(private readonly cookie = getShanbayCookie(), private readonly fetcher: ShanbayFetch = fetch) {}

  private async request(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetcher(`${BASE_URL}${path}`, {
          headers: { accept: "application/json", cookie: this.cookie },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          console.warn(`Shanbay request ${path} returned HTTP ${response.status}`);
          if (response.status === 401 || response.status === 403) throw new ShanbayError("Shanbay login expired.", "auth");
          if (response.status >= 500 && attempt < 2) continue;
          throw new ShanbayError("Shanbay unavailable.", "network");
        }
        let json: unknown;
        try { json = await response.json(); } catch { throw new ShanbayError("Shanbay API format changed.", "payload"); }
        try { return unwrapShanbayPayload(json); } catch {
          throw new ShanbayError("Unable to decode Shanbay response.", "decode");
        }
      } catch (error) {
        const safe = safeError(error);
        if (safe.code === "network") {
          const errorName = error instanceof Error ? error.name : "unknown";
          console.warn(`Shanbay request ${path} failed at network layer (${errorName})`);
        }
        if (safe.code !== "network" || attempt === 2) throw safe;
      }
    }
    throw new ShanbayError("Shanbay unavailable.", "network");
  }

  async getCurrentBook(): Promise<ShanbayBook> {
    try { return mapCurrentBook(await this.request("/wordsapp/user_material_books/current")); }
    catch (error) {
      if (error instanceof ShanbayError) throw error;
      throw new ShanbayError("No active Shanbay word book found.", "missing_book");
    }
  }

  async getPage(bookId: string, state: ShanbaySourceState, page: number): Promise<ShanbayWord[]> {
    const safeBookId = encodeURIComponent(bookId);
    const path = `/wordsapp/user_material_books/${safeBookId}/learning/words/${endpointState[state]}?page=${page}&ipp=${PAGE_SIZE}&order=ASC`;
    const decoded = await this.request(path) as ShanbayPage;
    if (!decoded || !Array.isArray(decoded.objects)) throw new ShanbayError("Shanbay API format changed.", "payload");
    return decoded.objects.map((item, index) => mapShanbayWord(item, state, (page - 1) * PAGE_SIZE + index));
  }

  async getAllWords(bookId: string): Promise<{ words: ShanbayWord[]; counts: Record<ShanbaySourceState, number> }> {
    const fetchState = async (state: ShanbaySourceState): Promise<ShanbayWord[]> => {
      const output: ShanbayWord[] = [];
      for (let page = 1; page <= 1000; page++) {
        const pageWords = await this.getPage(bookId, state, page);
        output.push(...pageWords);
        if (pageWords.length < PAGE_SIZE) break;
      }
      return output;
    };
    const states = Object.keys(endpointState) as ShanbaySourceState[];
    const pages = await Promise.all(states.map(fetchState));
    const words = pages.flat();
    const counts = Object.fromEntries(states.map((state, index) => [state, pages[index]!.length])) as Record<ShanbaySourceState, number>;
    return { words, counts };
  }
}
