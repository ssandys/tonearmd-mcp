import test from "node:test";
import assert from "node:assert";
import { createHttpServer } from "../src/http.js";

const KEY = "0123456789abcdef0123456789abcdef";
const STATUS = {
  v: 1, status: "ok",
  zone: { id: "z1", name: "chimaera", state: "playing", pinned: false, now_playing: null },
  zones: [{ id: "z1", name: "chimaera", state: "playing" }],
};

const INITIALIZE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

async function listening(t) {
  const server = createHttpServer({ request: async () => STATUS, key: KEY });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

const post = (url, headers, body) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify(body),
});

test("a request with no key is refused", async (t) => {
  // Without this the LAN drives the music.
  const res = await post(await listening(t), {}, INITIALIZE);
  assert.strictEqual(res.status, 401);
});

test("a request with the wrong key is refused", async (t) => {
  const res = await post(await listening(t), { authorization: "Bearer wrong" }, INITIALIZE);
  assert.strictEqual(res.status, 401);
});

test("the 401 body says nothing about why", async (t) => {
  // Distinguishing "malformed" from "wrong" hands an attacker a probe.
  const res = await post(await listening(t), { authorization: "Bearer wrong" }, INITIALIZE);
  const body = await res.text();
  assert.ok(!/length|malformed|missing|prefix/i.test(body), `leaked: ${body}`);
});

test("a request with the right key initializes and returns a session id", async (t) => {
  const res = await post(await listening(t), { authorization: `Bearer ${KEY}` }, INITIALIZE);
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("mcp-session-id"), "stateful mode must issue a session id");
});

test("an unknown session id is refused rather than silently starting a new session", async (t) => {
  // Silently minting a session would leak a slot per stale client.
  const res = await post(await listening(t),
    { authorization: `Bearer ${KEY}`, "mcp-session-id": "nope" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.ok(res.status === 404 || res.status === 400, `got ${res.status}`);
});

test("two initializes are two distinct sessions", async (t) => {
  // Each session id is what a browse slot is claimed against, so collapsing
  // two clients onto one id would collapse them onto one browse cursor.
  // That the slots themselves differ is covered by test/sessions.test.js.
  const url = await listening(t);
  const a = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const b = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const ida = a.headers.get("mcp-session-id");
  const idb = b.headers.get("mcp-session-id");
  assert.ok(ida && idb);
  assert.notStrictEqual(ida, idb);
});
