import { describe, expect, it } from "vitest";
import { ShanbayClient } from "../server/integrations/shanbay/client.js";

const lexical = { vocabulary: { word: "empirical", senses: [], sound: { ipa_us: "test" } } };

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

  it("rejects invalid payload shapes", async () => {
    const client = new ShanbayClient("auth_token=test", async () => Response.json({ data: { wrong: [] } }));
    await expect(client.getPage("book", "learning", 1)).rejects.toThrow("Shanbay API format changed");
  });
});
