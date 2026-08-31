import test from "node:test";
import assert from "node:assert";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHttpServer } from "../src/http.js";

const KEY = "0123456789abcdef0123456789abcdef";
const STATUS = {
  v: 1, status: "ok",
  zone: { id: "z1", name: "chimaera", state: "playing", pinned: true,
          now_playing: { title: "Jellybelly", artist: "The Smashing Pumpkins" } },
  zones: [{ id: "z1", name: "chimaera", state: "playing" }],
};

test("a real MCP client reaches a real tool over HTTP", async (t) => {
  // Every other test drives the pieces. This one proves the wiring: SDK
  // client -> HTTP -> auth -> transport -> buildServer -> tool -> daemon reply.
  const server = createHttpServer({ request: async () => STATUS, key: KEY });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // t.after hooks run in registration order, and the SDK client opens a
  // standing SSE GET stream right after initialize. http.Server#close waits
  // for every open connection to end on its own -- it never force-closes one
  // -- so if this hook ran before the client's, that still-open stream would
  // make close() hang forever. closeAllConnections() severs it immediately.
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });

  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${KEY}` } },
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.strictEqual(tools.tools.length, 6);

  const out = await client.callTool({ name: "tonearm_status", arguments: {} });
  assert.match(out.content[0].text, /Jellybelly/);
  assert.match(out.content[0].text, /pinned/);
});

test("a client with no key cannot connect at all", async (t) => {
  const server = createHttpServer({ request: async () => STATUS, key: KEY });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });

  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: "e2e-noauth", version: "0" });
  await assert.rejects(() => client.connect(new StreamableHTTPClientTransport(url)));
});
