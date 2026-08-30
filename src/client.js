import net from "node:net";
import os from "node:os";
import path from "node:path";

// The largest real request is a browse search whose term the user typed.
// A reply is a browse level: at most 100 rows (the daemon's PAGE), so 1 MiB
// is orders of magnitude clear of it while still bounding a wedged peer.
const MAX_REPLY_BYTES = 1024 * 1024;

// status is a snapshot the daemon already holds. browse goes out to Roon, and
// a play walks several levels; measured live, a browse search round-trips in
// about 0.9s. These are deliberately per-intent rather than one shared number.
export const TIMEOUTS = { status: 5000, browse: 25000, command: 5000 };

export class DaemonDownError extends Error {}
export class DaemonSilentError extends Error {}
export class DaemonProtocolError extends Error {}

export function defaultSocketPath() {
  const base = process.env.XDG_RUNTIME_DIR || path.join("/run/user", String(os.userInfo().uid));
  return path.join(base, "tonearm", "sock");
}

export function request(payload, opts = {}) {
  const socketPath = opts.socketPath || defaultSocketPath();
  const timeoutMs = opts.timeoutMs ?? TIMEOUTS.status;
  const expectReply = opts.expectReply !== false;

  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ path: socketPath });
    let buf = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new DaemonSilentError(
        `tonearmd accepted the connection but did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );

    conn.on("error", () => finish(reject, new DaemonDownError(
      `tonearmd is not running (no socket at ${socketPath})`)));

    conn.on("connect", () => conn.write(JSON.stringify(payload) + "\n"));

    conn.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > MAX_REPLY_BYTES) {
        return finish(reject, new DaemonProtocolError("reply exceeded 1 MiB"));
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(resolve, JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(reject, new DaemonProtocolError("reply was not valid JSON"));
      }
    });

    // EOF. For a command this is success; for anything else it means the
    // daemon hung up without answering.
    conn.on("end", () => {
      if (!expectReply) return finish(resolve, null);
      if (buf.trim() === "") {
        return finish(reject, new DaemonSilentError("tonearmd closed without a reply"));
      }
    });
  });
}
