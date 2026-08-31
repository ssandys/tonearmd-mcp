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
  // Three slots, releasing the MOST recent, so the freed slot is deliberately
  // not the one LRU eviction would pick. With a no-op release this returns
  // mcp-0 (the LRU victim) instead of mcp-2, which is what makes the
  // assertion mean something. The two-slot version of this test could not
  // tell the two apart -- the released slot was also the eviction target.
  const slots = createSlots(3);
  slots.claim("a");
  slots.claim("b");
  const third = slots.claim("c");
  slots.release("c");
  assert.strictEqual(slots.claim("d"), third);
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

test("slots are named mcp-0 through mcp-7", () => {
  // The constraint is on the literal key: the daemon's browse-session dict is
  // keyed by this string, and it is what shows up when debugging against a
  // live daemon. Every other assertion here is relational and would survive
  // a rename.
  const slots = createSlots();
  const keys = [];
  for (let i = 0; i < SLOT_COUNT; i += 1) keys.push(slots.claim(`s${i}`));
  assert.deepStrictEqual(keys.sort(), [
    "mcp-0", "mcp-1", "mcp-2", "mcp-3", "mcp-4", "mcp-5", "mcp-6", "mcp-7",
  ]);
});
