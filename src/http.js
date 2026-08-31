import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { createSlots } from "./sessions.js";
import { bearerOk } from "./auth.js";

const MAX_BODY_BYTES = 1024 * 1024;

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > MAX_BODY_BYTES) reject(new Error("body too large"));
  });
  req.on("end", () => {
    if (raw === "") return resolve(undefined);
    try { resolve(JSON.parse(raw)); } catch { reject(new Error("body was not valid JSON")); }
  });
  req.on("error", reject);
});

// A bare status line. Which part of the header was wrong is the attacker's
// question to answer, not ours.
const deny = (res, code) => { res.writeHead(code).end(); };

export function createHttpServer({ request, key, slots = createSlots() }) {
  const transports = new Map();

  return http.createServer(async (req, res) => {
    if (!bearerOk(req.headers.authorization, key)) return deny(res, 401);

    // The transport's own allowedHosts/allowedOrigins are deprecated in SDK
    // 1.30.0 in favour of external middleware. Belt and braces: a rebinding
    // attack still cannot produce the bearer key.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
      return deny(res, 403);
    }

    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const existing = transports.get(sid);
      if (!existing) return deny(res, 404);
      const body = req.method === "POST" ? await readBody(req).catch(() => undefined) : undefined;
      return existing.handleRequest(req, res, body);
    }

    if (req.method !== "POST") return deny(res, 400);

    let body;
    try { body = await readBody(req); } catch { return deny(res, 400); }
    if (!isInitializeRequest(body)) return deny(res, 400);

    // The id is minted here rather than left to sessionIdGenerator so the
    // browse slot can be claimed before buildServer needs it.
    const id = randomUUID();
    const session = slots.claim(id);
    const drop = () => { transports.delete(id); slots.release(id); };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: drop,
    });
    transport.onclose = drop;

    const server = buildServer({ request, session });
    await server.connect(transport);
    transports.set(id, transport);
    await transport.handleRequest(req, res, body);
  });
}
