import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same shape as tonearmd's own token: 0600 inside a 0700 directory, read from
// XDG_CONFIG_HOME at call time so it is not frozen at import.
export function keyPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "tonearm-mcp", "key");
}

export function loadOrCreateKey(p = keyPath()) {
  fs.mkdirSync(path.dirname(p), { mode: 0o700, recursive: true });
  try {
    const existing = fs.readFileSync(p, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    // ENOENT is the first-run case. Anything else -- EACCES, EISDIR -- must be
    // fatal: silently generating a new key here would lock out every client
    // that holds the old one, and look like the key "stopped working".
    if (err.code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, key + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);   // writeFileSync's mode is subject to umask
  return key;
}

export function bearerOk(header, key) {
  if (typeof header !== "string") return false;
  const m = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(key);
  // timingSafeEqual THROWS on a length mismatch. Comparing lengths first
  // leaks only the key's length, which the wire format already reveals.
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}
