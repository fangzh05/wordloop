// Fixture browser QA; this never logs in to a real user account.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const server = createServer(async (request, response) => {
  const path = request.url?.split("?")[0];
  const file = path === "/app.js" ? "standalone.js" : path === "/app.css" ? "widget.css" : null;
  response.setHeader("content-type", file ? file.endsWith(".js") ? "text/javascript" : "text/css" : "text/html");
  response.end(file ? await readFile(`web/dist/${file}`) : '<!doctype html><html><head><title>WordLoop import QA</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
await mkdir(".qa", { recursive: true });
try {
  for (const [name, width, height, theme] of [["desktop", 1280, 900, "light"], ["mobile", 390, 844, "dark"]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(theme => { localStorage.setItem("wordloop_web_token", "fixture-only"); localStorage.setItem("wordloop_appearance", theme); }, theme);
    let job = { jobId: "00000000-0000-4000-8000-000000000003", state: "waiting_login", expiresAt: Date.now() + 600000, processed: 0, added: 0, existing: 0 };
    let chunks = 0, listReads = 0;
    await context.route("**/api/web/**", async route => {
      const url = new URL(route.request().url()); let data = {};
      if (url.pathname === "/api/web/auth/config") data = { url: "https://fixture.supabase.co", key: "sb_publishable_fixture_only_key" };
      else if (url.pathname === "/api/web/bootstrap") data = { screen: "done", state: {}, session_revision: null, progress: { today: { total: 0, known: 0, uncertain: 0, unknown: 0, completed: 0 }, review_today: { completed: 0, total: 0, remaining: 0 }, all_time: { total_words: 0, mastered: 0, learning: 0, error_book: 0 }, fsrs: { due_now: 0, due_today: 0, tomorrow: 0, due_next_7_days: 0, average_stability: 0 }, settings: { daily_new_word_limit: 20 } } };
      else if (url.pathname === "/api/web/vocabulary") { listReads++; data = { data: { items: [] }, next_cursor: null }; }
      else if (url.pathname.endsWith("/start")) data = { ...job, liveUrl: "https://login.test/shanbay" };
      else if (url.pathname.endsWith("/status")) { job = { ...job, state: "ready", book: { id: "fixture", name: "四级词汇" } }; data = job; }
      else if (url.pathname.endsWith("/chunk")) { chunks++; job = { ...job, state: chunks === 2 ? "completed" : "importing", processed: chunks * 20 }; data = job; }
      else if (url.pathname.endsWith("/cancel")) { job = { ...job, state: "cancelled" }; data = job; }
      await route.fulfill({ json: data });
    });
    await context.route("https://login.test/**", route => route.fulfill({ body: "Fixture remote login", contentType: "text/html" }));
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/#vocabulary`);
    await page.getByRole("button", { name: "连接扇贝", exact: true }).waitFor();
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "连接扇贝", exact: true }).click();
    const login = await popup; await login.waitForURL("https://login.test/shanbay");
    await page.getByRole("button", { name: "导入「四级词汇」", exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "导入「四级词汇」", exact: true }).click();
    await page.getByText("导入完成，已处理 40 个词条。", { exact: true }).waitFor();
    if (chunks !== 2 || listReads < 2 || errors.length) throw new Error(JSON.stringify({ chunks, listReads, errors }));
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Horizontal overflow");
    await page.screenshot({ path: `.qa/shanbay-${name}.png`, fullPage: true });
    console.log(JSON.stringify({ viewport: name, theme, popup: true, importChunks: chunks, vocabularyRefreshed: true, overflow: false, errors }));
    await context.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
