import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../server/index.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const instance = createHttpApp().listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("Streamable HTTP server", () => {
  it("returns health status", async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "wordloop", status: "ok", mcp: "/mcp" });
  });

  it("initializes and lists focused data and render tools", async () => {
    const client = new Client({ name: "wordloop-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "import_words", "get_learning_context", "get_next_round", "record_pretest_result",
      "record_attempt", "get_error_book", "save_sentence", "get_progress",
      "render_word_import", "render_learning_dashboard", "render_pronunciation_cards", "render_dictation_widget",
    ]));
    await client.close();
  });
});

