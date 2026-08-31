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
