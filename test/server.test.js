import test from "node:test";
import assert from "node:assert";
import { buildServer, TOOL_NAMES } from "../src/server.js";

const STATUS = {
  v: 1, status: "ok",
  zone: { id: "z1", name: "chimaera", state: "playing",
          now_playing: { title: "Jellybelly", artist: "The Smashing Pumpkins" } },
  zones: [{ id: "z1", name: "chimaera", state: "playing" },
          { id: "z2", name: "sonos move", state: "stopped" }],
};

test("exactly the six tools in the spec are registered", () => {
  assert.deepStrictEqual([...TOOL_NAMES].sort(), [
    "tonearm_control", "tonearm_pin", "tonearm_play",
    "tonearm_search", "tonearm_status", "tonearm_transfer",
  ]);
});

test("the server constructs without touching a socket", () => {
  assert.ok(buildServer({ request: async () => STATUS }));
});

test("status reports the track and the zone list", async () => {
  const s = buildServer({ request: async () => STATUS });
  const out = await s._testInvoke("tonearm_status", {});
  assert.match(out.content[0].text, /Jellybelly/);
  assert.match(out.content[0].text, /sonos move/);
});

test("a mutating tool re-reads status instead of echoing its request", async () => {
  // MEASURED: commands are fire-and-forget -- the daemon returns EOF and never
  // confirms. _command_locked silently drops on an unknown verb or no zone. A
  // tool that echoed its own request would report success for a no-op, which
  // is the played:true-while-silent bug tonearm already had to fix.
  const calls = [];
  const deps = { request: async (p) => { calls.push(p.cmd); return p.cmd === "status" ? STATUS : null; } };
  const s = buildServer(deps);
  await s._testInvoke("tonearm_control", { action: "playpause" });
  assert.deepStrictEqual(calls, ["playpause", "status"]);
});

test("transfer resolves the zone name to an id before sending", async () => {
  const calls = [];
  const deps = { request: async (p) => { calls.push(p); return p.cmd === "status" ? STATUS : null; } };
  const s = buildServer(deps);
  await s._testInvoke("tonearm_transfer", { to_zone: "SONOS MOVE" });
  const sent = calls.find((c) => c.cmd === "transfer");
  assert.strictEqual(sent.arg, "z2", "must send the id, not the name");
});

test("an unknown zone comes back as a readable tool error, not a crash", async () => {
  // The registration-time guard: without it this throw reaches the MCP
  // transport instead of Claude.
  const s = buildServer({ request: async () => STATUS });
  const out = await s._testInvoke("tonearm_transfer", { to_zone: "kitchen" });
  assert.strictEqual(out.isError, true);
  assert.match(out.content[0].text, /chimaera, sonos move/);
});

test("pin accepts the literal 'unpin'", async () => {
  const calls = [];
  const deps = { request: async (p) => { calls.push(p); return p.cmd === "status" ? STATUS : null; } };
  const s = buildServer(deps);
  await s._testInvoke("tonearm_pin", { zone: "UnPin" });
  assert.deepStrictEqual(calls.find((c) => c.cmd === "zone").arg, "unpin");
});

test("a daemon that is down reads as prose, not a stack trace", async () => {
  const s = buildServer({ request: async () => { throw new Error("tonearmd is not running (no socket at /x)"); } });
  const out = await s._testInvoke("tonearm_status", {});
  assert.strictEqual(out.isError, true);
  assert.match(out.content[0].text, /tonearmd is not running/);
  assert.ok(!out.content[0].text.includes("at Object."), "no stack frames");
});
