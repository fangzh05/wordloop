import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GPT Sites surface", () => {
  it("ships a static entrypoint with local assets and no server secrets", async () => {
    const html = await readFile(new URL("../build/index.html", import.meta.url), "utf8");
    expect(html).toContain('<link rel="stylesheet" href="./styles.css"');
    expect(html).toContain('<script src="./app.js" defer></script>');
    expect(html).toContain("/api/mcp");
    expect(html).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|service_role_key|access_token/i);
  });

  it("includes motion, transparency, and contrast accessibility modes", async () => {
    const css = await readFile(new URL("../build/styles.css", import.meta.url), "utf8");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("prefers-reduced-transparency");
    expect(css).toContain("prefers-contrast");
  });
});
