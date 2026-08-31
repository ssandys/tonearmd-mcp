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
