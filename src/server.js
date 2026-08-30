#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { request as socketRequest, TIMEOUTS } from "./client.js";
import { searchLibrary, playRef } from "./library.js";
import { resolveZone } from "./zones.js";

export const TOOL_NAMES = [
  "tonearm_status", "tonearm_search", "tonearm_play",
  "tonearm_control", "tonearm_transfer", "tonearm_pin",
];

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

const readStatus = (deps) =>
  deps.request({ cmd: "status" }, { timeoutMs: TIMEOUTS.status });

const stateKey = (s) =>
  JSON.stringify([s?.zone?.id, s?.zone?.state, s?.zone?.now_playing?.title ?? null]);

// Commands are fire-and-forget; the daemon never confirms one. MEASURED: a
// playpause request returns EOF in 0.05s and never a line, and
// _command_locked silently drops on an unknown verb or no followed zone. So
// report from a status read, never from what we asked for.
//
// But the daemon reflects a command ASYNCHRONOUSLY -- measured at ~52ms for a
// pause -- so an immediate read returns the PREVIOUS state and the tool
// reports that the command did nothing. Poll until the state actually moves,
// bounded at 2s, then report whatever we have rather than block.
//
// The predicate matters and "the state changed" is NOT good enough. Caught
// live: pausing right after a play returned "playing", because the play was
// still landing and the poll saw THAT change and stopped. A verb knows what it
// is asking for, so it says so.
const track = (s) => s?.zone?.now_playing?.title ?? null;
const SETTLED = {
  pause: (_prior, now) => now?.zone?.state === "paused",
  playpause: (prior, now) => now?.zone?.state !== prior?.zone?.state,
  next: (prior, now) => track(now) !== track(prior),
  previous: (prior, now) => track(now) !== track(prior),
};
const changed = (prior, now) => stateKey(now) !== stateKey(prior);

const SETTLE_ATTEMPTS = 60;
const SETTLE_INTERVAL_MS = 50;   // 3s total

// Returns { status, confirmed }. `confirmed` false means the command was sent
// but the zone had not reflected it within the bound.
//
// Measured 2026-08-30: a pause on a steady zone reflects in ~154ms, and 1ms
// right after a transport play -- but after a BROWSE ACTIVATE, where Roon is
// still loading a fresh queue, it exceeded 2s. Rather than keep raising the
// bound until it stops being wrong, an unconfirmed command SAYS SO. Reporting
// "playing" in answer to a pause is worse than admitting we did not see it
// land.
async function command(deps, payload, before = null) {
  const prior = before ?? (await readStatus(deps));
  await deps.request(payload, { timeoutMs: TIMEOUTS.command, expectReply: false });
  const settled = SETTLED[payload.cmd] ?? changed;
  let status = prior;
  for (let i = 0; i < SETTLE_ATTEMPTS; i += 1) {
    await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
    status = await readStatus(deps);
    if (settled(prior, status)) return { status, confirmed: true };
  }
  return { status, confirmed: false };
}

function report({ status, confirmed }, what) {
  const line = describe(status);
  if (confirmed) return line;
  const secs = (SETTLE_ATTEMPTS * SETTLE_INTERVAL_MS) / 1000;
  return `Sent ${what}, but the zone had not reflected it after ${secs}s. ` +
         `It may still be settling. Last seen — ${line}`;
}

function describe(status) {
  if (!status || status.status !== "ok") {
    return `tonearm is not ready: ${status?.status ?? "no reply"}`;
  }
  const z = status.zone;
  if (!z) return "No zone is selected.";
  const np = z.now_playing;
  const what = np ? `${np.title}${np.artist ? ` — ${np.artist}` : ""}` : "nothing";
  return `${z.name}: ${z.state}, playing ${what}`;
}

export function buildServer(deps) {
  const server = new McpServer({ name: "tonearmd-mcp", version: "0.1.0" });
  const handlers = {};
  // Wrap at registration, not afterwards. An earlier draft wrapped only the
  // test seam -- so a thrown UnknownZoneError would have reached the MCP
  // transport in production while every test saw a tidy tool error.
  const add = (name, config, fn) => {
    const guarded = async (args) => {
      try { return await fn(args); } catch (err) { return fail(err.message); }
    };
    handlers[name] = guarded;
    server.registerTool(name, config, guarded);
  };
  server._testInvoke = (name, args) => handlers[name](args);

  add("tonearm_status",
    { description: "What is playing on Roon right now, and which zones exist.", inputSchema: {} },
    async () => {
      const status = await readStatus(deps);
      const zones = (status.zones ?? []).map((z) => `${z.name} (${z.state})`).join(", ");
      return text(`${describe(status)}\nZones: ${zones || "none"}`);
    });

  add("tonearm_search",
    { description: "Search the Roon library. Returns albums and tracks with refs to pass to tonearm_play.",
      inputSchema: { query: z.string().describe("What to look for, e.g. an album or track name") } },
    async ({ query }) => {
      const found = await searchLibrary(query, deps);
      if (found.length === 0) return text(`No results for ${JSON.stringify(query)}.`);
      return text(found.map((c) =>
        `[${c.kind}] ${c.title}${c.subtitle ? ` — ${c.subtitle}` : ""}\n  ref: ${c.ref}`).join("\n"));
    });

  add("tonearm_play",
    { description: "Play a search result in the zone the widget is following.",
      inputSchema: { ref: z.string().describe("A ref from tonearm_search. Pass it back unchanged.") } },
    async ({ ref }) => {
      // No status read. playRef already verified the daemon reported
      // played:true and knows exactly what it activated; a second read races
      // the daemon's ~52ms settle and produced output that contradicted
      // itself in live testing.
      const started = await playRef(ref, deps);
      return text(`Playing ${started.title}${started.subtitle ? ` — ${started.subtitle}` : ""}.`);
    });

  add("tonearm_control",
    { description: "Transport control for the followed zone.",
      inputSchema: { action: z.enum(["playpause", "pause", "next", "previous"]) } },
    async ({ action }) => text(report(await command(deps, { cmd: action }), `${action}`)));

  add("tonearm_transfer",
    { description: "Move what is playing to another zone, keeping the track and position.",
      inputSchema: { to_zone: z.string().describe("Destination zone name") } },
    async ({ to_zone }) => {
      const status = await readStatus(deps);
      const zone = resolveZone(status.zones, to_zone);
      return text(report(await command(deps, { cmd: "transfer", arg: zone.id }, status), `transfer to ${zone.name}`));
    });

  add("tonearm_pin",
    { description: "Change which zone the bar widget follows. Pass 'unpin' to resume auto-follow.",
      inputSchema: { zone: z.string().describe("A zone name, or 'unpin'") } },
    async ({ zone }) => {
      if (String(zone).trim().toLowerCase() === "unpin") {
        return text(report(await command(deps, { cmd: "zone", arg: "unpin" }), "unpin"));
      }
      const status = await readStatus(deps);
      const target = resolveZone(status.zones, zone);
      return text(report(await command(deps, { cmd: "zone", arg: target.id }, status), `pin to ${target.name}`));
    });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer({ request: socketRequest });
  await server.connect(new StdioServerTransport());
}
