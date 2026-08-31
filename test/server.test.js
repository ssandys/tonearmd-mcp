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
  // Asserts the INTENT, not an exact call sequence: the command is sent, and
  // status is read afterwards. An earlier version pinned the sequence to
  // exactly ["playpause","status"], which the settle poll legitimately broke
  // without anything being wrong.
  const sent = calls.indexOf("playpause");
  assert.ok(sent !== -1, "the command must actually be sent");
  assert.ok(calls.slice(sent + 1).includes("status"),
    "state must be read back from the daemon, not echoed from the request");
});

test("play does not append a status line that can contradict it", async () => {
  // LIVE-CAUGHT: the daemon reflects a play asynchronously (~52ms measured),
  // so reading status immediately returned the PREVIOUS track. The tool said
  // "Playing Kind Of Blue" and then, on the next line, "playing Jellybelly".
  // playRef already confirmed played:true and knows the title -- the extra
  // read added only a race.
  const stale = { ...STATUS, zone: { ...STATUS.zone, now_playing: { title: "Jellybelly", artist: "SP" } } };
  const s = buildServer({
    request: async (p) => {
      if (p.cmd === "status") return stale;
      if (p.op === "search") return { ok: true, level_id: 1, rows: [{ title: "Albums", can_descend: true }] };
      if (p.op === "enter") return { ok: true, level_id: 2, rows: [{ title: "Kind Of Blue", subtitle: "Miles Davis" }] };
      if (p.op === "activate") return { ok: true, played: true };
      return null;
    },
  });
  const ref = Buffer.from(JSON.stringify(
    { query: "kind of blue", category: "Albums", index: 0, title: "Kind Of Blue" })).toString("base64url");
  const out = await s._testInvoke("tonearm_play", { ref });
  assert.match(out.content[0].text, /Kind Of Blue/);
  assert.ok(!out.content[0].text.includes("Jellybelly"),
    "must not report a stale track alongside what it just started");
});

test("a command waits for the daemon to reflect it before reporting", async () => {
  // Measured: a pause takes ~52ms to appear in status. Reporting the first
  // read tells Claude the command did nothing.
  let reads = 0;
  const before = { ...STATUS, zone: { ...STATUS.zone, state: "playing" } };
  const after = { ...STATUS, zone: { ...STATUS.zone, state: "paused" } };
  const s = buildServer({
    request: async (p) => {
      if (p.cmd !== "status") return null;
      reads += 1;
      return reads <= 2 ? before : after;   // settles on the 3rd read
    },
  });
  const out = await s._testInvoke("tonearm_control", { action: "pause" });
  assert.match(out.content[0].text, /paused/);
});

test("pause waits for paused, not merely for any change", async () => {
  // LIVE-CAUGHT: pausing right after a play reported "playing". The poll saw
  // the PLAY still landing, decided something had changed, and stopped. A
  // change is not the change the verb asked for.
  const prior = { ...STATUS, zone: { ...STATUS.zone, state: "paused", now_playing: { title: "So What" } } };
  const midPlay = { ...STATUS, zone: { ...STATUS.zone, state: "playing", now_playing: { title: "Mellon Collie" } } };
  const paused = { ...STATUS, zone: { ...STATUS.zone, state: "paused", now_playing: { title: "Mellon Collie" } } };
  let n = 0;
  const s = buildServer({
    request: async (p) => {
      if (p.cmd !== "status") return null;
      n += 1;
      if (n === 1) return prior;
      return n <= 3 ? midPlay : paused;
    },
  });
  const out = await s._testInvoke("tonearm_control", { action: "pause" });
  assert.match(out.content[0].text, /paused/);
  assert.ok(!out.content[0].text.includes(": playing,"),
    "must not report playing in response to a pause");
});

test("an unconfirmed command says so rather than contradicting the request", async () => {
  // LIVE-CAUGHT: pause after a browse activate exceeded the bound, and the
  // tool answered a pause with "playing". Admitting we did not see it land
  // beats reporting the opposite of what was asked.
  const s = buildServer({ request: async (p) => (p.cmd === "status" ? STATUS : null) });
  const started = Date.now();
  const out = await s._testInvoke("tonearm_control", { action: "pause" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, `took ${elapsed}ms; the settle bound is 3s`);
  assert.match(out.content[0].text, /had not reflected it/);
  assert.match(out.content[0].text, /pause/);
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

test("status reports that the followed zone is pinned", async () => {
  // The daemon returns zone.pinned in every status reply and describe() dropped
  // it, so an agent that can SET the pin with tonearm_pin could not read it
  // back -- answering "which zone is pinned" meant shelling out to tonearmctl.
  const pinned = { ...STATUS, zone: { ...STATUS.zone, pinned: true } };
  const s = buildServer({ request: async () => pinned });
  const out = await s._testInvoke("tonearm_status", {});
  assert.match(out.content[0].text, /pinned/);
});

test("status reports auto-follow when no zone is pinned", async () => {
  // The other half: a hardcoded "(pinned)" would satisfy the test above while
  // still telling Claude nothing. Auto-follow means the zone can change on its
  // own, which is exactly what an agent needs to know before acting on it.
  const s = buildServer({ request: async () => STATUS });
  const out = await s._testInvoke("tonearm_status", {});
  assert.match(out.content[0].text, /auto-follow/);
  assert.ok(!out.content[0].text.includes("(pinned)"));
});

test("re-pinning the zone that is already pinned confirms instead of timing out", async () => {
  // LIVE-CAUGHT 2026-08-30: `zone` had no SETTLED entry, so it fell to the
  // default `changed` -- [zone.id, zone.state, now_playing.title]. Pinning the
  // already-followed zone moves none of those, so the poll ran its full 3s and
  // reported "had not reflected it" over a pin that was applied.
  const pinned = {
    ...STATUS,
    zone: { ...STATUS.zone, id: "z2", name: "sonos move", pinned: true },
  };
  const s = buildServer({ request: async (p) => (p.cmd === "status" ? pinned : null) });
  const started = Date.now();
  const out = await s._testInvoke("tonearm_pin", { zone: "sonos move" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed}ms; an already-applied pin must not wait out the 3s bound`);
  assert.ok(!out.content[0].text.includes("had not reflected it"),
    "a pin that is already in effect must report as confirmed");
});

test("unpin waits for the pin to clear, not for any change", async () => {
  // The same default-predicate bug in the other direction: a track changing
  // while the unpin is in flight satisfies `changed`, so the poll stops early
  // and reports a zone that is still pinned as though the unpin had landed.
  const at = (pinned, title) => ({
    ...STATUS,
    zone: { ...STATUS.zone, pinned, now_playing: { title, artist: "SP" } },
  });
  let n = 0;
  const s = buildServer({
    request: async (p) => {
      if (p.cmd !== "status") return null;
      n += 1;
      if (n === 1) return at(true, "So What");
      return n <= 3 ? at(true, "Mellon Collie") : at(false, "Mellon Collie");
    },
  });
  const out = await s._testInvoke("tonearm_pin", { zone: "unpin" });
  assert.match(out.content[0].text, /auto-follow/);
  assert.ok(!out.content[0].text.includes("(pinned)"),
    "must not report a still-pinned zone as unpinned");
});
