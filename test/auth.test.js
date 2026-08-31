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

test("a key file that has been loosened is tightened on load", () => {
  // Measured during review: without this, chmod 0644 on an existing key file
  // survived a restart and the server served with a world-readable key, while
  // the suite asserted 0600 and the README promised it.
  const p = path.join(tmp(), "tonearm-mcp", "key");
  loadOrCreateKey(p);
  fs.chmodSync(p, 0o644);
  loadOrCreateKey(p);
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
});

test("a key whose mode cannot be changed does not crash the load", () => {
  // Simulates a read-only mount (EROFS) or a file owned by someone else
  // (EPERM): the file read fine, so chmod failing afterward must not take
  // the whole server down at boot -- that would be worse than the exposure
  // the enforcement itself is trying to fix. Monkey-patches fs.chmodSync
  // rather than needing a real read-only mount, scoped to this file's path
  // and restored in `finally` so it cannot leak into other tests.
  const p = path.join(tmp(), "tonearm-mcp", "key");
  const key = loadOrCreateKey(p);

  const originalChmod = fs.chmodSync;
  fs.chmodSync = (target, mode) => {
    if (target === p) {
      const err = new Error("EROFS: read-only file system, chmod");
      err.code = "EROFS";
      throw err;
    }
    return originalChmod(target, mode);
  };
  try {
    assert.strictEqual(loadOrCreateKey(p), key);
  } finally {
    fs.chmodSync = originalChmod;
  }
});

test("a loose, un-tightenable key warns on stderr", () => {
  const p = path.join(tmp(), "tonearm-mcp", "key");
  loadOrCreateKey(p);
  fs.chmodSync(p, 0o644);   // loosened, and chmod below will be unable to fix it

  const originalChmod = fs.chmodSync;
  fs.chmodSync = (target, mode) => {
    if (target === p) {
      const err = new Error("EROFS: read-only file system, chmod");
      err.code = "EROFS";
      throw err;
    }
    return originalChmod(target, mode);
  };
  const originalError = console.error;
  const logged = [];
  console.error = (msg) => logged.push(msg);
  try {
    loadOrCreateKey(p);
    assert.ok(logged.some((m) => m.includes(p) && m.includes("644")),
      `no warning naming the file and its mode: ${JSON.stringify(logged)}`);
  } finally {
    console.error = originalError;
    fs.chmodSync = originalChmod;
    fs.chmodSync(p, 0o600);   // so the tmpdir can be cleaned up
  }
});

test("a key whose mode can be neither changed nor read still loads", () => {
  // Narrower still: chmod has already failed AND the file becomes
  // un-statable in that same window (e.g. it vanishes between the
  // successful readFileSync and this catch). An unguarded statSync here
  // would either crash the boot (non-ENOENT, via the outer rethrow) or
  // silently rotate a key that had just read fine (ENOENT, via the outer
  // catch's generate branch) -- the two worst failure modes this file has.
  const p = path.join(tmp(), "tonearm-mcp", "key");
  const key = loadOrCreateKey(p);

  const originalChmod = fs.chmodSync;
  const originalStat = fs.statSync;
  fs.chmodSync = (target, mode) => {
    if (target === p) {
      const err = new Error("EROFS: read-only file system, chmod");
      err.code = "EROFS";
      throw err;
    }
    return originalChmod(target, mode);
  };
  fs.statSync = (target, options) => {
    if (target === p) {
      const err = new Error("ENOENT: no such file or directory, stat");
      err.code = "ENOENT";
      throw err;
    }
    return originalStat(target, options);
  };
  const originalError = console.error;
  const logged = [];
  console.error = (msg) => logged.push(msg);
  try {
    assert.strictEqual(loadOrCreateKey(p), key);
    assert.ok(logged.some((m) => m.includes(p) && m.includes("could not be read")),
      `no warning naming the file with its mode unreadable: ${JSON.stringify(logged)}`);
  } finally {
    console.error = originalError;
    fs.chmodSync = originalChmod;
    fs.statSync = originalStat;
  }
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
