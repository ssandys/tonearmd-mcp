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
