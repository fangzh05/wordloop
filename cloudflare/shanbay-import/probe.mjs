// Read credentials from hidden stdin, never from command-line arguments/files.
import { createHmac } from "node:crypto";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write("Ready for probe JSON on stdin (input is hidden).\n");
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString();
  if (!/[\r\n]/.test(buffer)) return;
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    const { secret, url, input } = JSON.parse(buffer.trim());
    buffer = "";
    const timestamp = String(Date.now()); const body = JSON.stringify(input);
    const signature = createHmac("sha256", secret).update(`${timestamp}\n${body}`).digest("hex");
    const response = await fetch(new URL("/import", url), { method: "POST", headers: { "content-type": "application/json", "x-bridge-time": timestamp, "x-bridge-signature": signature }, body, signal: AbortSignal.timeout(65000) });
    process.stdout.write(JSON.stringify({ status: response.status, data: await response.json() }) + "\n");
    process.exit(0);
  } catch { process.stdout.write(JSON.stringify({ error: "PROBE_FAILED" }) + "\n"); process.exit(1); }
});
