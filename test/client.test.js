import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request, DaemonDownError, DaemonSilentError } from "../src/client.js";

function tmpSocket() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tonearmd-mcp-"));
  return path.join(dir, "sock");
}

// Stands up a stub daemon. `handler(line, conn)` decides what to send back.
function stubDaemon(socketPath, handler) {
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      handler(buf.slice(0, nl), conn);
    });
  });
  server.listen(socketPath);
  return server;
}

test("a reply-bearing request returns the parsed reply", async () => {
  const socketPath = tmpSocket();
  const server = stubDaemon(socketPath, (line, conn) => {
    assert.deepStrictEqual(JSON.parse(line), { cmd: "status" });
    conn.end(JSON.stringify({ v: 1, status: "ok" }) + "\n");
  });
  try {
    const reply = await request({ cmd: "status" }, { socketPath });
    assert.strictEqual(reply.status, "ok");
  } finally {
    server.close();
  }
});

test("a fire-and-forget command resolves null on EOF", async () => {
  // MEASURED: the daemon closes without writing for playpause/transfer/zone.
  const socketPath = tmpSocket();
  const server = stubDaemon(socketPath, (_line, conn) => conn.end());
  try {
    const reply = await request({ cmd: "playpause" }, { socketPath, expectReply: false });
    assert.strictEqual(reply, null);
  } finally {
    server.close();
  }
});

test("no daemon at the path raises DaemonDownError", async () => {
  await assert.rejects(
    () => request({ cmd: "status" }, { socketPath: tmpSocket() }),
    DaemonDownError,
  );
});

test("a daemon that accepts and never answers raises DaemonSilentError", async () => {
  // tonearmctl's lesson: a bare read with no deadline blocks forever.
  const socketPath = tmpSocket();
  const held = [];
  const server = stubDaemon(socketPath, (_line, conn) => held.push(conn));
  try {
    await assert.rejects(
      () => request({ cmd: "status" }, { socketPath, timeoutMs: 200 }),
      DaemonSilentError,
    );
  } finally {
    held.forEach((c) => c.destroy());
    server.close();
  }
});

test("the silent case gives up on the deadline, not much later", async () => {
  // Asserting only "it rejected" passes even if the deadline never fires and
  // something else ends the wait. Bound WHEN.
  const socketPath = tmpSocket();
  const held = [];
  const server = stubDaemon(socketPath, (_line, conn) => held.push(conn));
  try {
    const started = Date.now();
    await assert.rejects(() => request({ cmd: "status" }, { socketPath, timeoutMs: 200 }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `gave up after ${elapsed}ms; the deadline is 200ms`);
  } finally {
    held.forEach((c) => c.destroy());
    server.close();
  }
});
