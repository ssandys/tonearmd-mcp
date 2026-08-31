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

export function loadOrCreateKey(p = keyPath(), onCreate = () => {}) {
  fs.mkdirSync(path.dirname(p), { mode: 0o700, recursive: true });
  try {
    const existing = fs.readFileSync(p, "utf8").trim();
    if (existing) {
      // Enforce 0600 on every load, not only at creation: a key loosened by a
      // backup tool, a copy from another machine, or a careless chmod was
      // otherwise served at whatever mode it had for the rest of its life.
      //
      // Failure here must not be fatal. The file read fine, so we have a
      // usable key; chmod can still fail on a read-only mount (EROFS) or a
      // file owned by someone else (EPERM) -- and a foreign-owned, loosened
      // key is the very case this enforcement exists for. Crashing at boot
      // over it would be worse than the exposure it is trying to fix.
      try {
        fs.chmodSync(p, 0o600);
      } catch (err) {
        // Read the mode defensively: we are already on a failure path, and a
        // throw from here would either crash the boot (non-ENOENT, via the
        // outer rethrow) or silently rotate a key that read fine (ENOENT, via
        // the outer catch's generate branch). Both are worse than not knowing
        // the mode.
        let mode = null;
        try { mode = fs.statSync(p).mode & 0o777; } catch { /* leave unknown */ }
        if (mode === null) {
          console.error(
            `tonearmd-mcp: WARNING: ${p} could not be tightened (${err.code}) ` +
            `and its mode could not be read. Check it with: ls -l ${p}`);
        } else if (mode !== 0o600) {
          console.error(
            `tonearmd-mcp: WARNING: ${p} is mode ${mode.toString(8)} and could ` +
            `not be tightened (${err.code}). Anyone who can read it can drive ` +
            `your music. Fix with: chmod 600 ${p}`);
        }
      }
      return existing;
    }
  } catch (err) {
    // ENOENT is the first-run case. Anything else -- EACCES, EISDIR -- must be
    // fatal: silently generating a new key here would lock out every client
    // that holds the old one, and look like the key "stopped working".
    if (err.code !== "ENOENT") throw err;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, key + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);   // belt-and-braces for the creation path -- writeFileSync's mode option above already set 0600
  onCreate(key);
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
