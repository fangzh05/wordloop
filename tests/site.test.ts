import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GPT Sites surface", () => {
  it("ships a static entrypoint with local assets and no server secrets", async () => {
    const html = await readFile(new URL("../build/index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1"');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css"');
    expect(html).toContain('<script src="/app.js" defer></script>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|service_role_key|access_token/i);
  });

  it("ships PWA metadata and retains accessibility modes in the shared widget stylesheet", async () => {
    const manifest = await readFile(new URL("../build/manifest.webmanifest", import.meta.url), "utf8");
    const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ name: "WordLoop", short_name: "WordLoop", display: "standalone", start_url: "/" });
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("prefers-reduced-transparency");
    expect(css).toContain("prefers-contrast");
  });
});
