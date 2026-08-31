import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createHttpServer } from "../src/http.js";
import { createSlots } from "../src/sessions.js";

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

// Wraps createSlots so tests can observe claim/release calls directly,
// rather than inferring them from status codes -- which cannot tell "the
// feature works" from "the feature is gone and something else produced the
// same status".
function spySlots(n = 8) {
  const real = createSlots(n);
  const claimed = [];
  const released = [];
  return {
    claimed, released,
    claim: (id) => { claimed.push(id); return real.claim(id); },
    release: (id) => { released.push(id); real.release(id); },
  };
}

async function listening(t, opts = {}) {
  const server = createHttpServer({ request: async () => STATUS, key: KEY, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => {
    // http.Server#close() waits for every socket to fully drain, and an
    // aborted fetch() (the GET/SSE stream tests) can leave one lingering
    // for several seconds even though the server's own `res` "close" event
    // already fired. closeAllConnections() forces any that are left, since
    // by teardown time every test has already made its assertions.
    server.closeAllConnections();
    server.close(r);
  }));
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
  // Silently minting a session would leak a slot per stale client. Assert
  // the exact code (not "some 4xx") and that no slot was ever claimed for
  // it -- either alone can pass with the feature quietly removed.
  const spy = spySlots();
  const res = await post(await listening(t, { slots: spy }),
    { authorization: `Bearer ${KEY}`, "mcp-session-id": "nope" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(spy.claimed.length, 0, `claimed: ${JSON.stringify(spy.claimed)}`);
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

test("an idle session's slot is released by the sweep", async (t) => {
  // The SDK only signals close() from an explicit DELETE, which most
  // clients never send. A client that just vanishes must still be reclaimed,
  // or the allocator's LRU eventually starts evicting live sessions.
  const spy = spySlots();
  const url = await listening(t, { slots: spy, ttlMs: 30, sweepMs: 10 });
  const res = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(spy.released.includes(sid), `released: ${JSON.stringify(spy.released)}`);
});

test("a live session is not released while it keeps making requests", async (t) => {
  // Otherwise the sweep is indistinguishable from releasing everything on a
  // timer, which would silently truncate every long-lived session's slot.
  const spy = spySlots();
  const url = await listening(t, { slots: spy, ttlMs: 60, sweepMs: 15 });
  const init = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);

  const deadline = Date.now() + 150;
  let nextId = 2;
  while (Date.now() < deadline) {
    await post(url, { authorization: `Bearer ${KEY}`, "mcp-session-id": sid },
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} });
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(!spy.released.includes(sid), `released: ${JSON.stringify(spy.released)}`);
});

test("auth is enforced on GET requests", async (t) => {
  // All the earlier tests are POST; a regression that moved the auth check
  // below the session-id branch would pass every one of them.
  // Carries a plausible-looking session id and no key: if auth were checked
  // after the session lookup, this would answer 404 (revealing "no such
  // session" to a caller who never proved they hold the key) instead of
  // 401. A bare GET with no session header at all cannot tell those two
  // orderings apart, so this needs the header present to mean anything.
  const url = await listening(t);
  const res = await fetch(url, { method: "GET", headers: { "mcp-session-id": "nope" } });
  assert.strictEqual(res.status, 401);
});

test("auth is enforced on DELETE requests", async (t) => {
  const url = await listening(t);
  const res = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": "nope" } });
  assert.strictEqual(res.status, 401);
});

test("a foreign origin is refused", async (t) => {
  const res = await post(await listening(t),
    { authorization: `Bearer ${KEY}`, origin: "http://evil.example" }, INITIALIZE);
  assert.strictEqual(res.status, 403);
});

test("an oversized body on the initialize path is rejected with 413", async (t) => {
  const pad = "x".repeat(1024 * 1024 + 1000);
  const body = { ...INITIALIZE, params: { ...INITIALIZE.params, _pad: pad } };
  const res = await post(await listening(t), { authorization: `Bearer ${KEY}` }, body);
  assert.strictEqual(res.status, 413);
});

test("an oversized body on the established-session path is rejected with 413, and does not hang", async (t) => {
  // The original established-session path swallowed the body-too-large
  // rejection with .catch(() => undefined) and let the SDK re-read the
  // request with no limit applied at all.
  const url = await listening(t);
  const init = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);

  const pad = "x".repeat(1024 * 1024 + 1000);
  const body = { jsonrpc: "2.0", id: 5, method: "tools/list", params: { _pad: pad } };
  const res = await post(url, { authorization: `Bearer ${KEY}`, "mcp-session-id": sid }, body);
  assert.strictEqual(res.status, 413);
});

test("a multi-byte UTF-8 body split mid-character round-trips intact", async (t) => {
  // A body reader that decodes each chunk independently (`raw += chunk`,
  // which implicitly calls the Buffer's own toString('utf8')) does NOT
  // reliably surface as a 400: JSON *syntax* survives corruption of a
  // string *value* just fine, since replacing a few interior bytes with
  // U+FFFD does not break the surrounding quotes/braces. VERIFIED directly
  // against a naive `raw += chunk` reader: a name split mid-character came
  // back as "AAAAAAAAAA���本龍一BBBBBBBBBB" over a
  // *200*, silently corrupting the library's own artist names ("Björk",
  // "Sigur Rós", "坂本龍一"). So this asserts the round-tripped content is
  // byte-exact, not merely that the status code isn't 400.
  //
  // fetch()'s own chunking isn't controllable from here -- an earlier
  // version of this test tried to land a character on a 64 KiB boundary by
  // padding the body, and the actual split (measured empirically) fell
  // elsewhere, so the test never touched the bug it meant to catch. Two
  // explicit req.write() calls on a raw socket, split at a chosen byte
  // offset, are what actually guarantee two separate reads.
  const url = await listening(t);
  const { hostname, port, pathname } = new URL(url);

  const init = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);

  const cjk = "坂本龍一"; // Sakamoto Ryuichi, each character 3 bytes in UTF-8
  const markerId = `A${"A".repeat(9)}${cjk}${"B".repeat(9)}B`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: markerId, method: "tools/list", params: {} });
  const buf = Buffer.from(body, "utf8");
  const cjkByteStart = buf.indexOf(Buffer.from(cjk, "utf8"));
  const splitAt = cjkByteStart + 1; // one byte into the first CJK char's 3-byte sequence

  const text = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname, port, path: pathname, method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${KEY}`,
        "mcp-session-id": sid,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.write(buf.subarray(0, splitAt));
    // A real gap between writes, not just two writes in the same tick, is
    // what forces the server to see them as separate 'data' events rather
    // than one coalesced read.
    setTimeout(() => { req.write(buf.subarray(splitAt)); req.end(); }, 20);
  });

  assert.ok(text.includes(`"id":"${markerId}"`),
    `the request id did not round-trip intact -- body corrupted at the chunk split: ${text}`);
});

test("malformed JSON on the initialize path returns 400, not 500", async (t) => {
  // A bad request is the client's fault. Falling through to the generic
  // catch and answering 500 would tell them the server broke instead.
  const res = await fetch(await listening(t), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${KEY}` },
    body: "{not valid json",
  });
  assert.strictEqual(res.status, 400);
});

test("malformed JSON to an established session returns 400, not 500", async (t) => {
  const url = await listening(t);
  const init = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${KEY}`,
      "mcp-session-id": sid,
    },
    body: "{not valid json",
  });
  assert.strictEqual(res.status, 400);
});

test("a session whose only traffic is an open GET/SSE stream survives the sweep, then is released once the stream closes", async (t) => {
  // lastSeen is bumped only on dispatch. handleGetRequest resolves once the
  // notification stream is ESTABLISHED, not when it closes, so a client
  // that opens the stream and then sends no POST for a while must not be
  // treated as idle just because nothing bumped lastSeen since then.
  const spy = spySlots();
  const url = await listening(t, { slots: spy, ttlMs: 30, sweepMs: 10 });
  const init = await post(url, { authorization: `Bearer ${KEY}` }, INITIALIZE);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);

  const ac = new AbortController();
  const streamRes = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${KEY}`, "mcp-session-id": sid, accept: "text/event-stream" },
    signal: ac.signal,
  });
  assert.strictEqual(streamRes.status, 200);

  // Outlive several sweep intervals with the stream open and NO POST
  // traffic at all. If the sweep only trusts POST-driven lastSeen, this
  // alone is enough to trip it.
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!spy.released.includes(sid),
    `released while the stream was still open: ${JSON.stringify(spy.released)}`);

  // Now close the stream and confirm the session DOES eventually get
  // swept -- otherwise this test would only prove the sweep never fires,
  // not that it correctly distinguishes "connected" from "idle".
  ac.abort();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(spy.released.includes(sid),
    `not released after the stream closed: ${JSON.stringify(spy.released)}`);
});
