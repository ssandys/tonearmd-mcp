import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { searchLibrary, playRef, RefStaleError } from "../src/library.js";
import { encodeRef } from "../src/codec.js";

const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const SEARCH = fixture("search-kind-of-blue");
const ALBUMS = fixture("albums-kind-of-blue");

function fakeDaemon({ albums = ALBUMS, activate = { ok: true, played: true } } = {}) {
  const calls = [];
  const request = async (payload) => {
    calls.push(payload);
    if (payload.op === "search") return SEARCH;
    if (payload.op === "enter") return albums;
    if (payload.op === "back") return SEARCH;
    if (payload.op === "activate") return activate;
    if (payload.op === "reset") return { ok: true };
    throw new Error(`unexpected op ${payload.op}`);
  };
  return { request, calls };
}

test("search sends the mcp session key on every browse call", async () => {
  // FOLLOWUPS 9: a consumer minting a fresh key per request leaks sessions in
  // the daemon's unbounded dict.
  const d = fakeDaemon();
  await searchLibrary("kind of blue", d);
  assert.ok(d.calls.length > 0);
  for (const c of d.calls) assert.strictEqual(c.session, "mcp");
});

test("search descends into Albums and returns candidates", async () => {
  const d = fakeDaemon();
  const out = await searchLibrary("kind of blue", d);
  assert.ok(out.length > 0);
  assert.strictEqual(out[0].title, ALBUMS.rows[0].title);
  assert.ok(d.calls.some((c) => c.op === "enter"));
});

test("the second category is entered with the level_id back() returned", async () => {
  // MEASURED: back() bumps the generation counter (7 -> 8 -> 9), it does not
  // restore it. Reusing the original search level_id makes the second enter
  // stale, so Tracks would silently never be expanded.
  const levels = { search: 7, enter: 8, back: 9 };
  const calls = [];
  const request = async (payload) => {
    calls.push(payload);
    if (payload.op === "search") return { ...SEARCH, level_id: levels.search };
    if (payload.op === "enter") return { ...ALBUMS, level_id: levels.enter };
    if (payload.op === "back") return { ...SEARCH, level_id: levels.back };
    throw new Error(`unexpected op ${payload.op}`);
  };
  await searchLibrary("kind of blue", { request });
  const enters = calls.filter((c) => c.op === "enter");
  assert.strictEqual(enters.length, 2, "both Albums and Tracks should be entered");
  assert.strictEqual(enters[0].level_id, levels.search);
  assert.strictEqual(enters[1].level_id, levels.back, "second enter must use the post-back level");
});

test("play re-walks from the query rather than reusing a held level", async () => {
  const d = fakeDaemon();
  const ref = encodeRef({ query: "kind of blue", category: "Albums", index: 0, title: ALBUMS.rows[0].title });
  await playRef(ref, d);
  assert.deepStrictEqual(d.calls.map((c) => c.op).slice(0, 3), ["search", "enter", "activate"]);
});

test("play refuses when the row at that index no longer has the ref's title", async () => {
  // THE safety property. Roon's ordering can shift between search and play;
  // without this the failure is playing the wrong album silently.
  const d = fakeDaemon();
  const ref = encodeRef({ query: "kind of blue", category: "Albums", index: 0, title: "Something Else Entirely" });
  await assert.rejects(() => playRef(ref, d), RefStaleError);
  assert.ok(!d.calls.some((c) => c.op === "activate"), "must not activate after a mismatch");
});

test("play refuses when the index is now out of range", async () => {
  const d = fakeDaemon({ albums: { ...ALBUMS, rows: ALBUMS.rows.slice(0, 2) } });
  const ref = encodeRef({ query: "kind of blue", category: "Albums", index: 9, title: "Kind Of Blue" });
  await assert.rejects(() => playRef(ref, d), RefStaleError);
});

test("play surfaces a daemon refusal rather than claiming success", async () => {
  const d = fakeDaemon({ activate: { ok: false, error: "no_zone", message: "no Roon zone is selected to play into" } });
  const ref = encodeRef({ query: "kind of blue", category: "Albums", index: 0, title: ALBUMS.rows[0].title });
  await assert.rejects(() => playRef(ref, d), /no Roon zone is selected/);
});

test("play refuses when the daemon reports it did not actually play", async () => {
  // activate descends instead of playing when the row is a category. Claude
  // must not be told music started.
  const d = fakeDaemon({ activate: { ok: true, played: false } });
  const ref = encodeRef({ query: "kind of blue", category: "Albums", index: 0, title: ALBUMS.rows[0].title });
  await assert.rejects(() => playRef(ref, d), /did not start/);
});
