import { describe, expect, it, vi } from "vitest";
import { ShanbayClient } from "../server/integrations/shanbay/client.js";

const lexical = { vocabulary: { word: "empirical", senses: [], sound: { ipa_us: "test" } } };

function lexicalPage(count: number, state: string, page: number) {
  return Array.from({ length: count }, (_, index) => ({
    vocabulary: { word: `${state}-${page}-${index}`, senses: [], sound: { ipa_us: "test" } },
  }));
}

function pageFromUrl(input: RequestInfo | URL): { state: string; page: number } {
  const url = new URL(String(input));
  const state = url.pathname.split("/").at(-1) ?? "";
  return { state, page: Number(url.searchParams.get("page")) };
}

describe("Shanbay client", () => {
  it("reads current book and all three state endpoints", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); seen.push(url);
      if (url.endsWith("/current")) return Response.json({ materialbook_id: "book-1", materialbook: { name: "Book" } });
      return Response.json({ data: { objects: [lexical] } });
    };
    const client = new ShanbayClient("auth_token=test", fetcher);
    expect((await client.getCurrentBook()).name).toBe("Book");
    const result = await client.getAllWords("book-1");
    expect(result.words).toHaveLength(3);
    expect(seen.some((url) => url.includes("simple_learned_items"))).toBe(true);
  });

  it("maps 401 to a credential-safe error", async () => {
    const client = new ShanbayClient("auth_token=secret", async () => new Response(null, { status: 401 }));
    await expect(client.getCurrentBook()).rejects.toThrow("Shanbay login expired");
  });

  it("maps 403 to the same credential-safe error without logging the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new ShanbayClient("auth_token=very-secret", async () => new Response(null, { status: 403 }));
    await expect(client.getCurrentBook()).rejects.toThrow("Shanbay login expired");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("very-secret");
    warn.mockRestore();
  });

  it("rejects invalid payload shapes", async () => {
    const client = new ShanbayClient("auth_token=test", async () => Response.json({ data: { wrong: [] } }));
    await expect(client.getPage("book", "learning", 1)).rejects.toThrow("Shanbay API format changed");
  });

  it("returns bounded resumable chunks", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/current")) return Response.json({ materialbook_id: "book-1", name: "Book" });
      return Response.json({ data: { total: 25, objects: [lexical] } });
    };
    const client = new ShanbayClient("auth_token=test", fetcher);
    const chunk = await client.getWordChunk("book-1");
    expect(chunk.words).toHaveLength(3);
    expect(chunk.pages).toBe(3);
    expect(chunk.state_total).toBe(25);
    expect(chunk.next_cursor).toEqual({ state: "learning", page: 1 });
  });

  it("uses total-aware pagination through the final partial page", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); seen.push(url);
      const { state, page } = pageFromUrl(input);
      const count = page === 1 || page === 2 ? 10 : page === 3 ? 5 : 0;
      return Response.json({ data: { total: 25, objects: lexicalPage(count, state, page) } });
    };
    const result = await new ShanbayClient("auth_token=test", fetcher).getAllWords("book-1");
    expect(result.words).toHaveLength(75);
    expect(result.counts).toEqual({ unlearned: 25, learning: 25, simple_learned: 25 });
    for (const endpoint of ["unlearned_items", "learning_items", "simple_learned_items"]) {
      expect(seen.filter((url) => url.includes(endpoint))).toHaveLength(3);
      expect(seen.some((url) => url.includes(`${endpoint}?page=3&ipp=10`))).toBe(true);
      expect(seen.some((url) => url.includes(`${endpoint}?page=4&ipp=10`))).toBe(false);
    }
  });

  it("requests only the first page when total is zero", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      return Response.json({ data: { total: 0, objects: [] } });
    };
    const result = await new ShanbayClient("auth_token=test", fetcher).getAllWords("book-1");
    expect(result.words).toHaveLength(0);
    expect(seen).toHaveLength(3);
    expect(seen.every((url) => url.includes("page=1&ipp=10"))).toBe(true);
  });

  it("falls back without total and stops after the first partial page", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); seen.push(url);
      const { state, page } = pageFromUrl(input);
      const count = page === 1 || page === 2 ? 10 : page === 3 ? 3 : 0;
      return Response.json({ data: { objects: lexicalPage(count, state, page) } });
    };
    const result = await new ShanbayClient("auth_token=test", fetcher).getAllWords("book-1");
    expect(result.words).toHaveLength(69);
    expect(result.counts).toEqual({ unlearned: 23, learning: 23, simple_learned: 23 });
    for (const endpoint of ["unlearned_items", "learning_items", "simple_learned_items"]) {
      expect(seen.filter((url) => url.includes(endpoint))).toHaveLength(3);
      expect(seen.some((url) => url.includes(`${endpoint}?page=4&ipp=10`))).toBe(false);
    }
  });
});
