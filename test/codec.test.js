import test from "node:test";
import assert from "node:assert";
import { encodeRef, decodeRef, BadRefError } from "../src/codec.js";

const REF = { query: "kind of blue", category: "Albums", index: 0, title: "Kind Of Blue" };

test("a ref round-trips", () => {
  assert.deepStrictEqual(decodeRef(encodeRef(REF)), REF);
});

test("a ref is opaque", () => {
  const encoded = encodeRef(REF);
  assert.ok(!encoded.includes("kind of blue"));
  assert.ok(!encoded.includes("Albums"));
});

test("garbage is rejected, not guessed at", () => {
  for (const bad of ["", "not-a-ref", "!!!!", "eyJ"]) {
    assert.throws(() => decodeRef(bad), BadRefError, `accepted ${JSON.stringify(bad)}`);
  }
});

test("valid base64 of the wrong shape is rejected", () => {
  // The sharp case: decodes cleanly, is not a ref.
  const wrong = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
  assert.throws(() => decodeRef(wrong), BadRefError);
});

test("a non-integer index is rejected", () => {
  const bad = Buffer.from(JSON.stringify({ ...REF, index: "0" })).toString("base64url");
  assert.throws(() => decodeRef(bad), BadRefError);
});
