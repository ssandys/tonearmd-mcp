import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { EXPANDABLE, PER_CATEGORY_CAP, categoryIndex, buildCandidates } from "../src/candidates.js";
import { decodeRef } from "../src/codec.js";

const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const SEARCH = fixture("search-kind-of-blue");
const ALBUMS = fixture("albums-kind-of-blue");
const ZERO = fixture("search-zero");

test("only Albums and Tracks are expanded", () => {
  assert.deepStrictEqual(EXPANDABLE, ["Albums", "Tracks"]);
});

test("categoryIndex finds a category by title", () => {
  assert.strictEqual(typeof categoryIndex(SEARCH, "Albums"), "number");
  assert.strictEqual(SEARCH.rows[categoryIndex(SEARCH, "Albums")].title, "Albums");
});

test("categoryIndex returns null for a category the search did not return", () => {
  assert.strictEqual(categoryIndex(SEARCH, "Playlists"), null);
});

test("can_play cannot be used to find playable rows", () => {
  // MEASURED: true on every row of a successful search, category headers
  // included. This is why the policy matches titles.
  assert.ok(SEARCH.rows.every((r) => r.can_play === true));
  assert.ok(SEARCH.rows.some((r) => ["Artists", "Albums"].includes(r.title)));
});

test("candidates carry title, subtitle and kind", () => {
  const out = buildCandidates("kind of blue", { Albums: ALBUMS.rows });
  assert.ok(out.length > 0);
  assert.strictEqual(out[0].kind, "album");
  assert.strictEqual(out[0].title, ALBUMS.rows[0].title);
  assert.strictEqual(out[0].subtitle, ALBUMS.rows[0].subtitle);
});

test("each ref round-trips to the row that produced it", () => {
  const out = buildCandidates("kind of blue", { Albums: ALBUMS.rows });
  const ref = decodeRef(out[3].ref);
  assert.strictEqual(ref.query, "kind of blue");
  assert.strictEqual(ref.category, "Albums");
  assert.strictEqual(ref.index, 3);
  assert.strictEqual(ref.title, ALBUMS.rows[3].title);
});

test("each category is capped at ten", () => {
  assert.ok(ALBUMS.rows.length > PER_CATEGORY_CAP, "fixture must exceed the cap to test it");
  const out = buildCandidates("kind of blue", { Albums: ALBUMS.rows });
  assert.strictEqual(out.length, PER_CATEGORY_CAP);
});

test("the cap is per category, not overall", () => {
  const out = buildCandidates("q", { Albums: ALBUMS.rows, Tracks: ALBUMS.rows });
  assert.strictEqual(out.length, PER_CATEGORY_CAP * 2);
});

test("a missing category contributes nothing rather than throwing", () => {
  assert.deepStrictEqual(buildCandidates("q", {}), []);
  assert.deepStrictEqual(buildCandidates("q", { Albums: [] }), []);
});

test("a zero-result search yields no candidates", () => {
  // MEASURED: Roon returns one row titled "No Results" with can_play false.
  // There is no Albums category, so nothing expands and nothing is minted.
  assert.strictEqual(ZERO.rows[0].title, "No Results");
  assert.strictEqual(categoryIndex(ZERO, "Albums"), null);
  assert.deepStrictEqual(buildCandidates("zzzzznotathing", {}), []);
});
