import { spawn } from "node:child_process";
import path from "node:path";

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
    const inspectorEntry = path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "inspector", "clients", "launcher", "build", "index.js");
    const child = spawn(process.execPath, [inspectorEntry, "--cli", ...args], {
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

function parseInspectorJson(stdout, label) {
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed.result ?? parsed;
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

try {
  await waitForReady();
  const target = `http://127.0.0.1:${port}/mcp`;
  const strict = await runInspector([target, "--transport", "http", "--method", "tools/list", "--strict", "--format", "json"]);
  const appInfo = await runInspector([target, "--transport", "http", "--method", "tools/list", "--app-info"]);
  const resourceList = await runInspector([target, "--transport", "http", "--method", "resources/list", "--format", "json"]);
  const resources = parseInspectorJson(resourceList.stdout, "resources/list");
  const resourceUris = Array.isArray(resources.resources) ? resources.resources.map((resource) => resource.uri) : [];
  for (const uri of ["ui://wordloop/lesson-v3.html", "ui://wordloop/lesson-v2.html", "ui://wordloop/lesson.html"]) {
    if (!resourceUris.includes(uri)) throw new Error(`resources/list is missing ${uri}.`);
  }
  const resourceReads = {};
  let latestHtml;
  for (const uri of ["ui://wordloop/lesson-v3.html", "ui://wordloop/lesson-v2.html", "ui://wordloop/lesson.html"]) {
    const read = await runInspector([target, "--transport", "http", "--method", "resources/read", "--uri", uri, "--format", "json"]);
    const result = parseInspectorJson(read.stdout, `resources/read ${uri}`);
    const text = result.contents?.[0]?.text;
    if (typeof text !== "string" || !text.includes('data-widget-version="3"') || !text.includes('content="lesson"')) {
      throw new Error(`resources/read ${uri} did not return the current LessonWidget HTML.`);
    }
    resourceReads[uri] = { ok: true, widgetVersion: 3, htmlLength: text.length };
    if (uri === "ui://wordloop/lesson-v3.html") latestHtml = text;
    else resourceReads[uri === "ui://wordloop/lesson-v2.html" ? "v2MatchesV3" : "legacyMatchesV3"] = text === latestHtml;
  }
  if (!resourceReads.v2MatchesV3 || !resourceReads.legacyMatchesV3) throw new Error("Lesson resource aliases do not match the v3 HTML.");
  process.stdout.write(strict.stdout);
  process.stdout.write("\n");
  process.stdout.write(appInfo.stdout);
  process.stdout.write("\n");
  process.stdout.write(`${JSON.stringify({ method: "resources/list", resources: resourceUris })}\n`);
  process.stdout.write(`${JSON.stringify({ method: "resources/read", resources: resourceReads })}\n`);
} finally {
  server.kill("SIGTERM");
}
