import test from "node:test";
import assert from "node:assert";
import { resolveZone, UnknownZoneError } from "../src/zones.js";

// Captured live 2026-08-30.
const ZONES = [
  { id: "16012352e4acb1f5e9bae8bec7bf5df87fa4", name: "chimaera", state: "paused" },
  { id: "16015aef4547fc69dbf0aea58d836c52153d", name: "sonos move", state: "stopped" },
  { id: "1601bdb56757fb6c57dedd8a2d4adcfcd486", name: "Living Room Stereo", state: "stopped" },
];

test("an exact name resolves to its id", () => {
  assert.strictEqual(resolveZone(ZONES, "chimaera").id, ZONES[0].id);
});

test("case does not matter", () => {
  assert.strictEqual(resolveZone(ZONES, "living room stereo").id, ZONES[2].id);
  assert.strictEqual(resolveZone(ZONES, "SONOS MOVE").id, ZONES[1].id);
});

test("surrounding whitespace does not matter", () => {
  assert.strictEqual(resolveZone(ZONES, "  chimaera ").id, ZONES[0].id);
});

test("an id also resolves, so a ref-free caller can pass one through", () => {
  assert.strictEqual(resolveZone(ZONES, ZONES[1].id).id, ZONES[1].id);
});

test("an unknown zone names the ones that exist", () => {
  try {
    resolveZone(ZONES, "kitchen");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof UnknownZoneError);
    assert.deepStrictEqual(err.available, ["chimaera", "sonos move", "Living Room Stereo"]);
    assert.ok(err.message.includes("kitchen"));
  }
});

test("no zones at all is still an UnknownZoneError, with an empty list", () => {
  // Node's assert.throws returns undefined -- it is not Python's assertRaises
  // context manager. Inspect the error with a validation function instead.
  assert.throws(() => resolveZone([], "kitchen"), (err) => {
    assert.ok(err instanceof UnknownZoneError);
    assert.deepStrictEqual(err.available, []);
    return true;
  });
});
