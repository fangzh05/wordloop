// Synthetic browser QA: never submits credentials to Shanbay.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mobileLoginHtml, mobileLoginUrl } from "../cloudflare/shanbay-import/src/mobileLogin.ts";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const server = createServer((_, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(mobileLoginHtml);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = process.env.SHANBAY_KEYBOARD_QA_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const remote = await context.newPage();
    await remote.setContent('<input id="account"><input id="password" type="password">');
    await remote.locator("#account").focus();
    const commands = [], errors = [];
    let fail = false;
    await context.route("https://live.browser.run/**", route => route.fulfill({ contentType: "text/html", body: "Synthetic remote login view" }));
    await context.routeWebSocket("wss://live.browser.run/**", ws => {
      ws.onMessage(async raw => {
        const command = JSON.parse(String(raw)); commands.push(command);
        if (fail) { ws.send(JSON.stringify({ id: command.id, error: { message: "fixture failure" } })); return; }
        if (command.method === "Input.insertText") await remote.keyboard.insertText(command.params.text);
        if (command.method === "Input.dispatchKeyEvent") {
          if (command.params.type === "keyDown") await remote.keyboard.down(command.params.key);
          else await remote.keyboard.up(command.params.key);
        }
        ws.send(JSON.stringify({ id: command.id, result: {} }));
      });
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const live = "https://live.browser.run/ui/view?mode=tab&wss=" + encodeURIComponent("live.browser.run/api/devtools/browser/fixture/page/fixture?jwt=fixture");
    await page.goto(mobileLoginUrl(base, live));
    await page.getByText("已连接。先点扇贝输入框，再点这里输入。", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    const input = page.getByLabel("输入账号、密码或验证码");
    await input.click(); assert.equal(await input.evaluate(element => document.activeElement === element), true);
    await input.fill("用户@example.com"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("已发送。可选择下一个扇贝输入框继续输入。", { exact: true }).waitFor();
    assert.equal(await remote.locator("#account").inputValue(), "用户@example.com");
    assert.equal(await input.inputValue(), "");
    await page.getByRole("button", { name: "删除远端输入框的最后一个字符" }).click();
    await page.waitForFunction(() => !document.getElementById("erase").disabled);
    assert.equal(await remote.locator("#account").inputValue(), "用户@example.co");
    await remote.locator("#password").focus();
    await input.fill("synthetic-password"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    assert.equal(await remote.locator("#password").inputValue(), "synthetic-password");
    fail = true; await input.fill("retry-text"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("未确认发送成功，请检查扇贝输入框后再操作。", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "retry-text");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, localInputFocused: true, remoteTextAndBackspace: true, failurePreservesInput: true, commands: commands.length, overflow: false }));
    await context.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
