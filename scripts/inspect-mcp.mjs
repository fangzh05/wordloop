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
  const pronunciationUri = "ui://wordloop/pronunciation.html";
  const pronunciationResource = resources.resources?.find((resource) => resource.uri === pronunciationUri);
  const expectedPronunciationUi = {
    prefersBorder: true,
    csp: {
      connectDomains: [],
      resourceDomains: [
        "https://media.merriam-webster.com",
        "https://dictionaryapi.com",
      ],
    },
  };
  if (JSON.stringify(pronunciationResource?._meta?.ui) !== JSON.stringify(expectedPronunciationUi)) {
    throw new Error("resources/list pronunciation metadata is missing the expected CSP.");
  }
  const pronunciationRead = await runInspector([target, "--transport", "http", "--method", "resources/read", "--uri", pronunciationUri, "--format", "json"]);
  const pronunciationResult = parseInspectorJson(pronunciationRead.stdout, `resources/read ${pronunciationUri}`);
  if (JSON.stringify(pronunciationResult.contents?.[0]?._meta?.ui) !== JSON.stringify(expectedPronunciationUi)) {
    throw new Error("resources/read pronunciation metadata is missing the expected CSP.");
  }
  const widgetUris = {
    lesson: ["ui://wordloop/lesson-v8.html", "ui://wordloop/lesson-v7.html", "ui://wordloop/lesson-v6.html", "ui://wordloop/lesson-v5.html", "ui://wordloop/lesson-v4.html", "ui://wordloop/lesson-v3.html", "ui://wordloop/lesson-v2.html", "ui://wordloop/lesson.html"],
    dictation: ["ui://wordloop/dictation-v2.html", "ui://wordloop/dictation.html"],
  };
  const resourceReads = {};
  for (const [kind, uris] of Object.entries(widgetUris)) {
    let latestHtml;
    for (const uri of uris) {
      const listing = resources.resources?.find((resource) => resource.uri === uri);
      if (!listing) throw new Error(`resources/list is missing ${uri}.`);
      if (JSON.stringify(listing._meta?.ui) !== JSON.stringify(expectedPronunciationUi)) throw new Error(`resources/list ${uri} has incorrect CSP.`);
      const read = await runInspector([target, "--transport", "http", "--method", "resources/read", "--uri", uri, "--format", "json"]);
      const result = parseInspectorJson(read.stdout, `resources/read ${uri}`);
      const content = result.contents?.[0];
      const html = content?.text;
      if (JSON.stringify(content?._meta?.ui) !== JSON.stringify(expectedPronunciationUi)) throw new Error(`resources/read ${uri} has incorrect CSP.`);
      if (typeof html !== "string" || !html.includes(`content="${kind}"`) || (kind === "lesson" && !html.includes('data-widget-version="3"'))) {
        throw new Error(`resources/read ${uri} did not return the current ${kind} HTML.`);
      }
      if (latestHtml !== undefined && html !== latestHtml) throw new Error(`${uri} did not serve the current ${kind} bundle.`);
      latestHtml = html;
      resourceReads[uri] = { ok: true, htmlLength: html.length };
    }
  }
  process.stdout.write(strict.stdout);
  process.stdout.write("\n");
  process.stdout.write(appInfo.stdout);
  process.stdout.write("\n");
  process.stdout.write(`${JSON.stringify({ method: "resources/list", resources: resourceUris })}\n`);
  process.stdout.write(`${JSON.stringify({ method: "resources/read", resources: resourceReads, pronunciationCsp: expectedPronunciationUi })}\n`);
} finally {
  server.kill("SIGTERM");
}
