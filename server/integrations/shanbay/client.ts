import { getShanbayCookie, getShanbayCsrfToken } from "../../db.js";
import { unwrapShanbayPayload } from "./decode.js";
import { mapCurrentBook, mapShanbayWord } from "./mapper.js";
import type { ShanbayBook, ShanbayPage, ShanbaySourceState, ShanbayWord } from "./types.js";

const BASE_URL = "https://apiv3.shanbay.com";
// Shanbay's web client uses a conservative page size. Larger values can leave
// the encrypted vocabulary response hanging behind the API gateway.
const PAGE_SIZE = 10;
const PAGE_CONCURRENCY = 8;
// Keep one MCP call comfortably below ChatGPT/Worker request limits. The
// importer asks for another cursor after each chunk, so a large book never
// has to stay inside one long-running request.
const IMPORT_PAGES_PER_CHUNK = 5;
const endpointState: Record<ShanbaySourceState, string> = {
  unlearned: "unlearned_items", learning: "learning_items", simple_learned: "simple_learned_items",
};

export type ShanbayFetch = typeof fetch;

export interface ShanbayImportCursor {
  state: ShanbaySourceState;
  page: number;
}

export interface ShanbayWordChunk {
  words: ShanbayWord[];
  state: ShanbaySourceState;
  page: number;
  pages: number;
  state_total: number | null;
  next_cursor: ShanbayImportCursor | null;
}

// Cloudflare Workers' fetch implementation checks that it is called with
// globalThis as its receiver. Passing `fetch` directly as a callback and then
// invoking it as a class property changes `this` to the client instance and
// raises "Illegal invocation" before any request reaches Shanbay.
const defaultShanbayFetch: ShanbayFetch = globalThis.fetch.bind(globalThis);

export class ShanbayError extends Error {
  constructor(message: string, readonly code: "auth" | "decode" | "missing_book" | "payload" | "network") { super(message); }
}

function safeError(error: unknown): ShanbayError {
  if (error instanceof ShanbayError) return error;
  return new ShanbayError("Shanbay unavailable.", "network");
}

export class ShanbayClient {
  constructor(
    private readonly cookie = getShanbayCookie(),
    private readonly fetcher: ShanbayFetch = defaultShanbayFetch,
    private readonly csrfToken = getShanbayCsrfToken(),
  ) {}

  private async request(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response: Response;
        try {
          response = await this.fetcher(`${BASE_URL}${path}`, {
            headers: {
              accept: "application/json, text/plain, */*",
              cookie: this.cookie,
              ...(this.csrfToken ? { "x-csrftoken": this.csrfToken } : {}),
              referer: "https://web.shanbay.com/",
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
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
          const errorMessage = error instanceof Error
            ? error.message.replace(/auth_token=[^;\s]+/giu, "auth_token=[redacted]").slice(0, 120)
            : "unknown error";
          console.warn(`Shanbay request ${path} failed at network layer (${errorName}: ${errorMessage})`);
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

  private async getPagePayload(bookId: string, state: ShanbaySourceState, page: number): Promise<{ words: ShanbayWord[]; total?: number }> {
    const safeBookId = encodeURIComponent(bookId);
    const path = `/wordsapp/user_material_books/${safeBookId}/learning/words/${endpointState[state]}?page=${page}&ipp=${PAGE_SIZE}&order=ASC`;
    const decoded = await this.request(path) as ShanbayPage;
    if (!decoded || !Array.isArray(decoded.objects)) throw new ShanbayError("Shanbay API format changed.", "payload");
    const total = typeof decoded.total === "number" && Number.isFinite(decoded.total) ? decoded.total : undefined;
    return {
      words: decoded.objects.map((item, index) => mapShanbayWord(item, state, (page - 1) * PAGE_SIZE + index)),
      total,
    };
  }

  async getPage(bookId: string, state: ShanbaySourceState, page: number): Promise<ShanbayWord[]> {
    return (await this.getPagePayload(bookId, state, page)).words;
  }

  /**
   * Read a bounded page chunk for a resumable import.  The cursor contains no
   * credentials and is safe for the widget to keep locally between calls.
   * Database writes happen in the importer after this method returns.
   */
  async getWordChunk(bookId: string, cursor?: ShanbayImportCursor, pagesPerChunk = IMPORT_PAGES_PER_CHUNK): Promise<ShanbayWordChunk> {
    const states = Object.keys(endpointState) as ShanbaySourceState[];
    const state = cursor?.state ?? states[0]!;
    const stateIndex = states.indexOf(state);
    if (stateIndex < 0) throw new ShanbayError("Invalid Shanbay import cursor.", "payload");
    const page = cursor?.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 100_000) {
      throw new ShanbayError("Invalid Shanbay import cursor.", "payload");
    }
    const boundedPages = Math.max(1, Math.min(Math.trunc(pagesPerChunk), PAGE_CONCURRENCY));
    const first = await this.getPagePayload(bookId, state, page);
    const totalPages = first.total === undefined ? undefined : Math.ceil(first.total / PAGE_SIZE);
    const remaining = totalPages === undefined
      ? first.words.length < PAGE_SIZE ? 1 : boundedPages
      : Math.max(1, Math.min(boundedPages, totalPages - page + 1));
    const pageNumbers = Array.from({ length: remaining }, (_, offset) => page + offset);
    const pages = await Promise.all(pageNumbers.slice(1).map((pageNumber) => this.getPagePayload(bookId, state, pageNumber)));
    const fetchedPages = [first, ...pages];
    const words = fetchedPages.flatMap((pagePayload) => pagePayload.words);
    const lastPage = page + fetchedPages.length - 1;
    const stateDone = totalPages !== undefined
      ? lastPage >= totalPages
      : fetchedPages.some((pagePayload) => pagePayload.words.length < PAGE_SIZE);
    const nextState = states[stateIndex + 1];
    return {
      words,
      state,
      page,
      pages: fetchedPages.length,
      state_total: first.total ?? null,
      next_cursor: stateDone
        ? nextState ? { state: nextState, page: 1 } : null
        : { state, page: lastPage + 1 },
    };
  }

  async getAllWords(bookId: string): Promise<{ words: ShanbayWord[]; counts: Record<ShanbaySourceState, number> }> {
    const fetchState = async (state: ShanbaySourceState): Promise<ShanbayWord[]> => {
      const first = await this.getPagePayload(bookId, state, 1);
      const output = [...first.words];
      if (first.total !== undefined) {
        const pageCount = Math.ceil(first.total / PAGE_SIZE);
        for (let start = 2; start <= pageCount; start += PAGE_CONCURRENCY) {
          const pageNumbers = Array.from(
            { length: Math.min(PAGE_CONCURRENCY, pageCount - start + 1) },
            (_, offset) => start + offset,
          );
          const pages = await Promise.all(pageNumbers.map((page) => this.getPagePayload(bookId, state, page)));
          for (const page of pages) output.push(...page.words);
        }
        return output;
      }

      if (first.words.length < PAGE_SIZE) return output;

      // Older Shanbay responses may omit `total`; retain a bounded sequential
      // fallback for those payloads.
      for (let page = 2; page <= 1000; page++) {
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
