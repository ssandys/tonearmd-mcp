# tonearmd-mcp over HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let MCP clients elsewhere on the LAN drive the same `tonearmd`, over a Streamable HTTP transport guarded by a shared bearer key, without changing `tonearmd`.

**Architecture:** `buildServer()` is unchanged and gains no transport knowledge. A new `src/http.js` runs a `node:http` listener that checks a bearer key, then hands each MCP session its own `McpServer` + `StreamableHTTPServerTransport` pair. Each session claims one of eight fixed browse-session slots so the daemon's `_browse_sessions` dict stays bounded. stdio remains the default and is untouched.

**Tech Stack:** Plain JavaScript (ES modules), Node >= 20, `@modelcontextprotocol/sdk` 1.30.0, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-tonearmd-mcp-http-design.md`

## Global Constraints

- **Plain JavaScript, no build step, no TypeScript.** Matches the existing repo.
- **No new dependencies.** Only `@modelcontextprotocol/sdk` (1.30.0) and `zod` (^3.25.1). `express` and `hono` exist only as transitives of the SDK — never import them.
- **`node:http` directly.** The transport's `handleRequest(req, res, parsedBody)` takes Node's `IncomingMessage`/`ServerResponse`.
- **Tests need no network and no daemon.** Every test passes a fake `request` or binds port 0.
- **`tonearm` is untouched.** No file outside this repo changes.
- **Slot count is 8.** `mcp-0` … `mcp-7`.
- **Default bind is `0.0.0.0:9340`.** Bare `--http` means exactly that.
- **stdio stays the default.** Running with no flag and no env var behaves exactly as today.

---

### Task 1: Thread a browse-session key through `deps`

The daemon namespaces browse cursors by a session key (`server.py:151`). `library.js` hardcodes `"mcp"`, so every client shares one cursor. This makes the key a per-server value carried on `deps`, so the HTTP layer can give each session its own — **without changing `searchLibrary` / `playRef` signatures**, because `deps` already reaches every browse call.

**Files:**
- Modify: `src/library.js:8-11`
- Test: `test/library-session.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `buildServer({ request, session })` — when `session` is a string, every `browse` request carries it as its `session` field. Omitted, it stays `"mcp"`. No other signature changes.

- [ ] **Step 1: Write the failing test**

`test/library-session.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { buildServer } from "../src/server.js";

const LEVEL = { ok: true, level_id: 1, rows: [] };

function recorder(reply = LEVEL) {
  const sent = [];
  return {
    sent,
    request: async (p) => { sent.push(p); return p.cmd === "browse" ? reply : null; },
  };
}

test("a server built with a session key sends it on every browse", async () => {
  // The daemon keys _browse_sessions on this field. Two clients sharing one
  // key share one cursor: a search from one resets the other's navigation.
  const rec = recorder();
  const s = buildServer({ request: rec.request, session: "mcp-3" });
  await s._testInvoke("tonearm_search", { query: "kind of blue" });
  const browses = rec.sent.filter((p) => p.cmd === "browse");
  assert.ok(browses.length > 0, "the search must actually browse");
  for (const p of browses) assert.strictEqual(p.session, "mcp-3");
});

test("without a session key it stays on the historical 'mcp'", async () => {
  // stdio callers pass no session. Changing the default would orphan the
  // browse cursor the running daemon already holds for them.
  const rec = recorder();
  const s = buildServer({ request: rec.request });
  await s._testInvoke("tonearm_search", { query: "kind of blue" });
  const browses = rec.sent.filter((p) => p.cmd === "browse");
  assert.ok(browses.length > 0);
  for (const p of browses) assert.strictEqual(p.session, "mcp");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/library-session.test.js`
Expected: FAIL — the first test reports `'mcp' !== 'mcp-3'`. The second passes already; that is correct and expected, it pins the default against regression.

- [ ] **Step 3: Write minimal implementation**

In `src/library.js`, replace lines 8-11:

```js
const DEFAULT_SESSION = "mcp";
// The daemon keys _browse_sessions on this (server.py:151). It rides on deps
// rather than a parameter so every existing call site is unchanged: stdio
// passes nothing and keeps "mcp"; the HTTP layer passes one slot per session.
const browse = (deps, op, extra = {}) =>
  deps.request({ cmd: "browse", session: deps.session || DEFAULT_SESSION, op, ...extra },
               { timeoutMs: TIMEOUTS.browse });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 53 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/library.js test/library-session.test.js
git commit -m "feat: carry the browse-session key on deps"
```

---

### Task 2: Bounded slot allocator

A fresh browse key per MCP session would grow the daemon's `_browse_sessions` dict forever — the daemon has no "drop session" verb, so a closed session leaks its entry (`FOLLOWUPS` item 9). Eight fixed slots bound it: the daemon sees at most eight keys for all time.

**Files:**
- Create: `src/sessions.js`
- Test: `test/sessions.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `createSlots(n = 8) -> { claim(id: string) -> string, release(id: string) -> void }`. `claim` is idempotent per id. `SLOT_COUNT` is exported as `8`.

- [ ] **Step 1: Write the failing test**

`test/sessions.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { createSlots, SLOT_COUNT } from "../src/sessions.js";

test("the slot count is eight", () => {
  assert.strictEqual(SLOT_COUNT, 8);
});

test("two sessions get different keys", () => {
  // Same key means one shared browse cursor: a search from one resets the
  // other's navigation mid-list.
  const slots = createSlots();
  assert.notStrictEqual(slots.claim("a"), slots.claim("b"));
});

test("claiming twice with the same id returns the same key", () => {
  // Every request in a session claims; a fresh key per request would exhaust
  // the pool in eight requests.
  const slots = createSlots();
  assert.strictEqual(slots.claim("a"), slots.claim("a"));
});

test("a released slot is handed to the next session", () => {
  const slots = createSlots(2);
  const first = slots.claim("a");
  slots.claim("b");
  slots.release("a");
  assert.strictEqual(slots.claim("c"), first);
});

test("more sessions than slots reuses, never grows", () => {
  // The whole point: the daemon must never see a ninth key. Exceeding the
  // pool degrades to a shared cursor, which is today's behaviour, not a leak.
  const slots = createSlots(8);
  const keys = new Set();
  for (let i = 0; i < 40; i += 1) keys.add(slots.claim(`s${i}`));
  assert.strictEqual(keys.size, 8);
});

test("the evicted slot is the least recently claimed", () => {
  const slots = createSlots(2);
  const a = slots.claim("a");
  slots.claim("b");
  slots.claim("a");             // a is now the more recent of the two
  assert.notStrictEqual(slots.claim("c"), a, "must evict b, not a");
});

test("releasing an id that holds no slot is a no-op", () => {
  // onsessionclosed and onclose can both fire for one session.
  const slots = createSlots(2);
  const a = slots.claim("a");
  slots.release("a");
  slots.release("a");
  assert.strictEqual(slots.claim("b"), a);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sessions.test.js`
Expected: FAIL — `Cannot find module '../src/sessions.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/sessions.js`:

```js
// The daemon keeps one BrowseSession per session key and never evicts one
// (FOLLOWUPS item 9), and offers no verb to drop one. So the key space is
// bounded here instead: at most SLOT_COUNT keys are ever sent, no matter how
// many MCP sessions come and go. Exceeding the pool makes two sessions share
// a cursor -- which is exactly today's single-key behaviour, not corruption.
export const SLOT_COUNT = 8;

export function createSlots(n = SLOT_COUNT) {
  const slots = Array.from({ length: n }, (_, i) => ({ key: `mcp-${i}`, id: null, used: 0 }));
  let tick = 0;

  return {
    claim(id) {
      let slot = slots.find((s) => s.id === id);
      if (!slot) {
        slot = slots.find((s) => s.id === null)
            ?? slots.reduce((a, b) => (a.used <= b.used ? a : b));
        slot.id = id;
      }
      slot.used = ++tick;
      return slot.key;
    },
    release(id) {
      const slot = slots.find((s) => s.id === id);
      if (slot) slot.id = null;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 60 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/sessions.js test/sessions.test.js
git commit -m "feat: bounded browse-session slot allocator"
```

---

### Task 3: The shared key and the bearer check

**Files:**
- Create: `src/auth.js`
- Test: `test/auth.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `keyPath() -> string` — `$XDG_CONFIG_HOME/tonearm-mcp/key`, falling back to `~/.config/tonearm-mcp/key`. Read at call time, so tests can set the env var.
  - `loadOrCreateKey(p = keyPath()) -> string` — reads and trims an existing key, or generates a 64-char hex key, writing it `0600` inside a `0700` directory.
  - `bearerOk(header: string | undefined, key: string) -> boolean` — constant-time, never throws.

- [ ] **Step 1: Write the failing test**

`test/auth.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyPath, loadOrCreateKey, bearerOk } from "../src/auth.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tonearm-mcp-"));

test("a short key is rejected, not a crash", () => {
  // crypto.timingSafeEqual THROWS on unequal lengths rather than returning
  // false. Unguarded, any stranger sending "Bearer x" takes the server down
  // -- a rejection turned into a denial of service.
  assert.strictEqual(bearerOk("Bearer x", "0123456789abcdef"), false);
});

test("a wrong key of the right length is rejected", () => {
  assert.strictEqual(bearerOk("Bearer 0000000000000000", "0123456789abcdef"), false);
});

test("the right key is accepted", () => {
  assert.strictEqual(bearerOk("Bearer 0123456789abcdef", "0123456789abcdef"), true);
});

test("a missing or malformed header is rejected", () => {
  for (const h of [undefined, "", "Bearer", "Basic 0123456789abcdef", "0123456789abcdef"]) {
    assert.strictEqual(bearerOk(h, "0123456789abcdef"), false, `accepted ${JSON.stringify(h)}`);
  }
});

test("the key file is created 0600 inside a 0700 directory", () => {
  // The key is the only thing between the LAN and the music. Default umask
  // would make it world-readable on a shared box.
  const dir = tmp();
  const p = path.join(dir, "tonearm-mcp", "key");
  const key = loadOrCreateKey(p);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
});

test("an existing key is reused, not regenerated", () => {
  // Regenerating would silently lock out every client on every restart.
  const p = path.join(tmp(), "tonearm-mcp", "key");
  assert.strictEqual(loadOrCreateKey(p), loadOrCreateKey(p));
});

test("an unreadable key file is fatal, not silently rotated", () => {
  // Generating a fresh key here would lock out every client holding the old
  // one, and present as "the key stopped working" with nothing in the log.
  const dir = tmp();
  const p = path.join(dir, "tonearm-mcp", "key");
  loadOrCreateKey(p);
  fs.chmodSync(p, 0o000);
  try {
    assert.throws(() => loadOrCreateKey(p), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(p, 0o600);   // so the tmpdir can be cleaned up
  }
});

test("keyPath honours XDG_CONFIG_HOME", () => {
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/xdg";
  try {
    assert.strictEqual(keyPath(), "/xdg/tonearm-mcp/key");
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../src/auth.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/auth.js`:

```js
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same shape as tonearmd's own token: 0600 inside a 0700 directory, read from
// XDG_CONFIG_HOME at call time so it is not frozen at import.
export function keyPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "tonearm-mcp", "key");
}

export function loadOrCreateKey(p = keyPath()) {
  fs.mkdirSync(path.dirname(p), { mode: 0o700, recursive: true });
  try {
    const existing = fs.readFileSync(p, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    // ENOENT is the first-run case. Anything else -- EACCES, EISDIR -- must be
    // fatal: silently generating a new key here would lock out every client
    // that holds the old one, and look like the key "stopped working".
    if (err.code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, key + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);   // writeFileSync's mode is subject to umask
  return key;
}

export function bearerOk(header, key) {
  if (typeof header !== "string") return false;
  const m = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(key);
  // timingSafeEqual THROWS on a length mismatch. Comparing lengths first
  // leaks only the key's length, which the wire format already reveals.
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 68 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/auth.js test/auth.test.js
git commit -m "feat: shared key file and constant-time bearer check"
```

---

### Task 4: The HTTP listener

**Files:**
- Create: `src/http.js`
- Test: `test/http.test.js` (create)

**Interfaces:**
- Consumes: `buildServer` (`src/server.js`), `createSlots` (Task 2), `bearerOk` (Task 3).
- Produces: `createHttpServer({ request, key, slots }) -> http.Server`. The caller calls `.listen()`. `slots` defaults to a fresh `createSlots()`.

- [ ] **Step 1: Write the failing test**

`test/http.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/http.test.js`
Expected: FAIL — `Cannot find module '../src/http.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/http.js`:

```js
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { createSlots } from "./sessions.js";
import { bearerOk } from "./auth.js";

const MAX_BODY_BYTES = 1024 * 1024;

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > MAX_BODY_BYTES) reject(new Error("body too large"));
  });
  req.on("end", () => {
    if (raw === "") return resolve(undefined);
    try { resolve(JSON.parse(raw)); } catch { reject(new Error("body was not valid JSON")); }
  });
  req.on("error", reject);
});

// A bare status line. Which part of the header was wrong is the attacker's
// question to answer, not ours.
const deny = (res, code) => { res.writeHead(code).end(); };

export function createHttpServer({ request, key, slots = createSlots() }) {
  const transports = new Map();

  return http.createServer(async (req, res) => {
    if (!bearerOk(req.headers.authorization, key)) return deny(res, 401);

    // The transport's own allowedHosts/allowedOrigins are deprecated in SDK
    // 1.30.0 in favour of external middleware. Belt and braces: a rebinding
    // attack still cannot produce the bearer key.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
      return deny(res, 403);
    }

    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const existing = transports.get(sid);
      if (!existing) return deny(res, 404);
      const body = req.method === "POST" ? await readBody(req).catch(() => undefined) : undefined;
      return existing.handleRequest(req, res, body);
    }

    if (req.method !== "POST") return deny(res, 400);

    let body;
    try { body = await readBody(req); } catch { return deny(res, 400); }
    if (!isInitializeRequest(body)) return deny(res, 400);

    // The id is minted here rather than left to sessionIdGenerator so the
    // browse slot can be claimed before buildServer needs it.
    const id = randomUUID();
    const session = slots.claim(id);
    const drop = () => { transports.delete(id); slots.release(id); };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: drop,
    });
    transport.onclose = drop;

    const server = buildServer({ request, session });
    await server.connect(transport);
    transports.set(id, transport);
    await transport.handleRequest(req, res, body);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 74 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/http.js test/http.test.js
git commit -m "feat: HTTP listener with bearer auth and per-session slots"
```

---

### Task 5: The entry point, and an end-to-end round trip

**Files:**
- Modify: `src/server.js` (the `import.meta.url` block at the bottom, and the imports)
- Test: `test/entrypoint.test.js` (create), `test/e2e.test.js` (create)

**Interfaces:**
- Consumes: `createHttpServer` (Task 4), `loadOrCreateKey` (Task 3).
- Produces: `parseListen(argv: string[], env: object) -> { host, port } | null`, exported for test. `null` means stdio.

- [ ] **Step 1: Write the failing test**

`test/entrypoint.test.js`:

```js
import test from "node:test";
import assert from "node:assert";
import { parseListen } from "../src/server.js";

test("no flag and no env means stdio", () => {
  // Every existing local install runs this way. A default that listened would
  // put the daemon on the LAN on upgrade, without anyone asking.
  assert.strictEqual(parseListen([], {}), null);
});

test("bare --http is 0.0.0.0:9340", () => {
  assert.deepStrictEqual(parseListen(["--http"], {}), { host: "0.0.0.0", port: 9340 });
});

test("--http with a port keeps the default host", () => {
  assert.deepStrictEqual(parseListen(["--http", "9999"], {}), { host: "0.0.0.0", port: 9999 });
});

test("--http with host:port sets both", () => {
  assert.deepStrictEqual(parseListen(["--http", "127.0.0.1:9999"], {}),
                         { host: "127.0.0.1", port: 9999 });
});

test("TONEARM_MCP_HTTP works without the flag", () => {
  assert.deepStrictEqual(parseListen([], { TONEARM_MCP_HTTP: "127.0.0.1:9999" }),
                         { host: "127.0.0.1", port: 9999 });
});

test("the flag beats the env var", () => {
  assert.deepStrictEqual(parseListen(["--http", "9998"], { TONEARM_MCP_HTTP: "9999" }),
                         { host: "0.0.0.0", port: 9998 });
});

test("a non-numeric port throws rather than listening somewhere surprising", () => {
  assert.throws(() => parseListen(["--http", "banana"], {}), /port/i);
});
```

`test/e2e.test.js`:

```js
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
  t.after(() => new Promise((r) => server.close(r)));

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
  t.after(() => new Promise((r) => server.close(r)));

  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: "e2e-noauth", version: "0" });
  await assert.rejects(() => client.connect(new StreamableHTTPClientTransport(url)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/entrypoint.test.js test/e2e.test.js`
Expected: `entrypoint.test.js` FAILS with `does not provide an export named 'parseListen'`. `e2e.test.js` should already PASS — it exercises Task 4's server, and confirms the wiring before the entry point exists.

- [ ] **Step 3: Write minimal implementation**

In `src/server.js`, add to the imports at the top:

```js
import { createHttpServer } from "./http.js";
import { loadOrCreateKey } from "./auth.js";
```

Add this exported function next to `VERSION`:

```js
const DEFAULT_LISTEN = { host: "0.0.0.0", port: 9340 };

// null means stdio. stdio is the default because every existing install runs
// that way: a default that listened would put this on the LAN on upgrade.
export function parseListen(argv, env) {
  const i = argv.indexOf("--http");
  const spec = i === -1
    ? env.TONEARM_MCP_HTTP
    : (argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : "");
  if (spec === undefined) return null;
  if (spec === "") return { ...DEFAULT_LISTEN };

  const colon = spec.lastIndexOf(":");
  const host = colon === -1 ? DEFAULT_LISTEN.host : spec.slice(0, colon);
  const port = Number(colon === -1 ? spec : spec.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--http: ${JSON.stringify(spec)} has no valid port`);
  }
  return { host, port };
}
```

Replace the `import.meta.url` block at the bottom:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const listen = parseListen(process.argv.slice(2), process.env);
  if (listen) {
    const key = loadOrCreateKey();
    const server = createHttpServer({ request: socketRequest, key });
    server.on("error", (err) => {
      // EADDRINUSE as a stack trace under systemd is unreadable in journalctl.
      console.error(`tonearmd-mcp: cannot listen on ${listen.host}:${listen.port} — ${err.message}`);
      process.exit(1);
    });
    server.listen(listen.port, listen.host, () => {
      console.error(`tonearmd-mcp listening on http://${listen.host}:${listen.port}/mcp`);
      console.error(`key: ${key}`);
    });
  } else {
    const server = buildServer({ request: socketRequest });
    await server.connect(new StdioServerTransport());
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 83 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/entrypoint.test.js test/e2e.test.js
git commit -m "feat: --http entry point, with an end-to-end round trip"
```

---

### Task 6: The unit file and the documentation

**Files:**
- Create: `systemd/tonearmd-mcp.service`
- Modify: `README.md`
- Modify: `docs/FOLLOWUPS.md`

**Interfaces:**
- Consumes: everything above. Produces nothing consumed by code.

- [ ] **Step 1: Write the unit file**

`systemd/tonearmd-mcp.service`:

```ini
[Unit]
Description=tonearmd-mcp — MCP server for tonearmd, over HTTP
# Politeness, not correctness: this server opens a fresh unix connection per
# request, so a daemon that is not up yet reads as "tonearmd is not running"
# until it is. Ordering only avoids a confusing window at login.
After=tonearmd.service
Wants=tonearmd.service

[Service]
Type=simple
ExecStart=/usr/bin/node %h/Src/tonearmd-mcp/src/server.js --http
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

There is deliberately no `RuntimeDirectory=`: `tonearmd.service` has one because systemd owns the socket directory, and this server owns no runtime state — it is a client of that socket.

- [ ] **Step 2: Verify the unit parses**

Run: `systemd-analyze verify systemd/tonearmd-mcp.service`
Expected: no output about syntax. A warning that `tonearmd.service` cannot be resolved from this path is expected and fine — the real unit lives under the plugin directory.

- [ ] **Step 3: Document HTTP mode in the README**

Add after the existing `## Install` section:

````markdown
## Running it on the network

By default the MCP client spawns this over stdio, on the same machine as
`tonearmd`. To let MCP clients elsewhere on your LAN drive the same daemon:

```bash
node src/server.js --http          # 0.0.0.0:9340
node src/server.js --http 9999     # another port
node src/server.js --http 127.0.0.1:9999
```

On first start it generates a key at `~/.config/tonearm-mcp/key` (mode `0600`)
and prints it. Point remote clients at the URL with that key as a bearer token:

```json
{
  "mcpServers": {
    "tonearm": {
      "type": "http",
      "url": "http://your-tonearm-box:9340/mcp",
      "headers": { "Authorization": "Bearer <the key>" }
    }
  }
}
```

To run it as a service, copy `systemd/tonearmd-mcp.service` to
`~/.config/systemd/user/`, adjust `ExecStart` to your checkout path, then
`systemctl --user enable --now tonearmd-mcp`.

**This is plain HTTP, for a LAN you trust.** Anything already on the network can
read the key and your listening history. That is a deliberate trade: TLS here
would mean certificates every MCP client has to trust. If your network has
guests or devices you don't trust, put a reverse proxy terminating TLS in front
of it rather than exposing this directly.

All sessions share one zone. Two clients asking for music at once get one zone
and last-writer-wins, not two streams — see `docs/FOLLOWUPS.md` item 2.
````

- [ ] **Step 4: Record the deferred work**

Add to `docs/FOLLOWUPS.md`, above the `## Closed` section:

```markdown
## 2. Every HTTP session shares one zone

`tonearmd` has one followed zone, one pin and one transport state, so several
MCP sessions driving it at once get one zone and a fight over it. `tonearm_pin`
over HTTP also still writes `pinned_zone_id` to `~/.config/tonearm/config.json`
— a remote call repoints the bar widget on the tonearm machine. For one person
on several machines that is the wanted behaviour; for two people it is not.

The upgrade is half-built already. `BrowseSession.__init__` takes a
`zone_id_provider` — a callable, per session, deliberately read at call time so
a repin between browses is honoured (`browse.py:160-168`) — and `core.py:590`
currently hands every session the same global `selected_zone_id`. Making it
per-session is a small daemon change.

What is not built is the transport half: `command(verb, arg)` (`core.py:616`)
acts on the followed zone and takes no zone argument, so `playpause` / `pause` /
`next` / `previous` would stay global. A session that starts music in its own
zone but pauses the widget's is worse than not having the feature, because it
looks like it works. Both halves or neither.

Doing it also closes item 9's LRU cap, since per-session zones make the fixed
eight-slot bound in `src/sessions.js` unnecessary.

Deferred until `tonearmd` moves to its own repository, at which point the
daemon-side changes stop being cross-repo work.
```

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 83 tests, 0 failures.

```bash
git add systemd/ README.md docs/FOLLOWUPS.md
git commit -m "docs: HTTP mode, the systemd unit, and the shared-zone follow-up"
```

---

## Verification

After Task 6, before opening a PR:

- [ ] `npm test` — 83 tests, 0 failures.
- [ ] Stdio unchanged: `node src/server.js` with the existing local MCP client config still answers `tonearm_status`.
- [ ] Live HTTP: start with `--http`, then from another machine on the LAN point an MCP client at `http://<box>:9340/mcp` with the key and call `tonearm_status`. Confirm the answer matches `scripts/tonearmctl status` on the tonearm box.
- [ ] Wrong key from that machine gets `401`.
- [ ] `README.md`'s test count matches what `npm test` reports.
