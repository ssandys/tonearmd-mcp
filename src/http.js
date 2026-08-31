import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { createSlots } from "./sessions.js";
import { bearerOk } from "./auth.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

class BodyTooLargeError extends Error {}
class BadBodyError extends Error {}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let settled = false;
  req.on("data", (c) => {
    // Once oversized, stop retaining chunks but keep draining -- req.destroy()
    // was tried here first and is wrong: it closes the socket immediately, so
    // the 413 the caller writes afterward never reaches the client. MEASURED:
    // with destroy(), the client's fetch() failed with a raw socket error
    // ("other side closed" / ECONNRESET, 0 bytes read) instead of ever seeing
    // a 413. Dropping (not storing) further chunks bounds memory the same way
    // the destroy() was meant to, without cutting the connection out from
    // under the response we still need to send.
    if (settled) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      settled = true;
      chunks.length = 0;
      return reject(new BodyTooLargeError());
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (settled) return;
    settled = true;
    if (chunks.length === 0) return resolve(undefined);
    // Concat the buffers, never `str += chunk`: a multi-byte character split
    // across two TCP segments decodes to U+FFFD when each chunk is stringified
    // alone. This is a music library -- "Björk", "Sigur Rós", "坂本龍一" are
    // ordinary input, not edge cases.
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { reject(new BadBodyError("body was not valid JSON")); }
  });
  req.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
});

// A bare status line. Which part of the header was wrong is the attacker's
// question to answer, not ours.
const deny = (res, code) => { res.writeHead(code).end(); };

export function createHttpServer({
  request, key, slots = createSlots(),
  ttlMs = SESSION_TTL_MS, sweepMs = SWEEP_MS,
}) {
  const transports = new Map();
  const lastSeen = new Map();
  const openStreams = new Map();   // session id -> count of open streams

  const drop = (id) => {
    const transport = transports.get(id);
    transports.delete(id);
    lastSeen.delete(id);
    openStreams.delete(id);
    slots.release(id);
    return transport;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!bearerOk(req.headers.authorization, key)) return deny(res, 401);

      // The transport's own allowedHosts/allowedOrigins are deprecated in SDK
      // 1.30.0 in favour of external middleware.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
        return deny(res, 403);
      }

      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const existing = transports.get(sid);
        if (!existing) return deny(res, 404);
        lastSeen.set(sid, Date.now());

        if (req.method === "GET") {
          openStreams.set(sid, (openStreams.get(sid) ?? 0) + 1);
          res.on("close", () => {
            const left = (openStreams.get(sid) ?? 1) - 1;
            if (left > 0) openStreams.set(sid, left);
            else openStreams.delete(sid);
            // Only now does the session start counting as idle. Guard on the
            // transport still existing so a stream closing AFTER a drop cannot
            // resurrect a lastSeen entry for a session that is gone.
            if (transports.has(sid)) lastSeen.set(sid, Date.now());
          });
        }

        const body = req.method === "POST" ? await readBody(req) : undefined;
        return await existing.handleRequest(req, res, body);
      }

      if (req.method !== "POST") return deny(res, 400);
      const body = await readBody(req);
      if (!isInitializeRequest(body)) return deny(res, 400);

      // Minted here rather than by sessionIdGenerator so the slot can be
      // claimed before buildServer needs it.
      const id = randomUUID();
      const session = slots.claim(id);
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => id,
          onsessionclosed: () => drop(id),
        });
        transport.onclose = () => drop(id);
        const mcp = buildServer({ request, session });
        await mcp.connect(transport);
        transports.set(id, transport);
        lastSeen.set(id, Date.now());
        await transport.handleRequest(req, res, body);
      } catch (err) {
        // claim() already happened. Without this the slot belongs to a session
        // that never existed and can never be released.
        drop(id);
        throw err;
      }
    } catch (err) {
      // http.createServer does NOT catch a rejection from an async listener:
      // unhandled, it takes the whole process down without answering anyone.
      if (res.headersSent) return res.destroy();
      if (err instanceof BodyTooLargeError) return deny(res, 413);
      if (err instanceof BadBodyError) return deny(res, 400);
      deny(res, 500);
    }
  });

  // The SDK only calls close() from handleDeleteRequest, so onclose and
  // onsessionclosed together cover exactly one path. Everything else -- a
  // client that drops the connection, a laptop that sleeps, a crash -- is
  // caught here or not at all.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    for (const [id, seen] of [...lastSeen]) {
      if (openStreams.has(id)) continue;      // still connected, not idle
      if (seen <= cutoff) drop(id)?.close?.().catch(() => {});
    }
  }, sweepMs);
  sweep.unref();                                  // must not hold the process open
  server.on("close", () => clearInterval(sweep));

  return server;
}
