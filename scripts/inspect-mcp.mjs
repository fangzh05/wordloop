import { spawn } from "node:child_process";

const port = "3101";
const server = spawn(process.execPath, ["node-dist/server/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: port, HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Wordloop did not start in time.")), 10_000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Wordloop listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`Wordloop exited early with ${code}.`)));
  });
}

function runInspector(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", "@modelcontextprotocol/inspector", "--cli", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Inspector exited with ${code}: ${stderr || stdout}`));
    });
  });
}

try {
  await waitForReady();
  const target = `http://127.0.0.1:${port}/mcp`;
  const strict = await runInspector([target, "--transport", "http", "--method", "tools/list", "--strict", "--format", "json"]);
  const appInfo = await runInspector([target, "--transport", "http", "--method", "tools/list", "--app-info"]);
  process.stdout.write(strict.stdout);
  process.stdout.write("\n");
  process.stdout.write(appInfo.stdout);
} finally {
  server.kill("SIGTERM");
}
