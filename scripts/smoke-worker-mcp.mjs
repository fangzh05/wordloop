import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = process.argv[2];
if (!origin) throw new Error("Usage: node scripts/smoke-worker-mcp.mjs <worker-origin>");

const endpoint = new URL("/api/mcp", origin);
const client = new Client({ name: "wordloop-worker-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint);
const startedAt = performance.now();

try {
  await client.connect(transport);
  const [toolResult, resourceResult] = await Promise.all([
    client.listTools(),
    client.listResources(),
  ]);
  const toolNames = new Set(toolResult.tools.map((tool) => tool.name));
  for (const required of ["get_study_bootstrap", "render_lesson_widget", "record_review_submission"]) {
    if (!toolNames.has(required)) throw new Error(`MCP tools/list is missing ${required}.`);
  }

  const lessonUri = "ui://wordloop/lesson-v9.html";
  if (!resourceResult.resources.some((resource) => resource.uri === lessonUri)) {
    throw new Error(`MCP resources/list is missing ${lessonUri}.`);
  }
  const resourceResultRead = await client.readResource({ uri: lessonUri });
  const html = resourceResultRead.contents.find((content) => "text" in content)?.text;
  if (typeof html !== "string" || !html.includes('content="lesson"') || !html.includes('data-widget-version="3"')) {
    throw new Error("MCP resources/read did not return the current Lesson widget HTML.");
  }

  console.log(JSON.stringify({
    endpoint: endpoint.href,
    initialized: true,
    tools: toolNames.size,
    resources: resourceResult.resources.length,
    lesson_widget_chars: html.length,
    elapsed_ms: Math.round(performance.now() - startedAt),
  }));
} finally {
  await client.close();
}
