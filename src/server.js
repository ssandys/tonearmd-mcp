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

// Commands are fire-and-forget; the daemon never confirms one. MEASURED: a
// playpause request returns EOF in 0.05s and never a line, and
// _command_locked silently drops on an unknown verb or no followed zone.
// Always report from a fresh status read, never from what we asked for.
async function command(deps, payload) {
  await deps.request(payload, { timeoutMs: TIMEOUTS.command, expectReply: false });
  return readStatus(deps);
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
      const started = await playRef(ref, deps);
      const status = await readStatus(deps);
      return text(`Playing ${started.title}${started.subtitle ? ` — ${started.subtitle}` : ""}.\n${describe(status)}`);
    });

  add("tonearm_control",
    { description: "Transport control for the followed zone.",
      inputSchema: { action: z.enum(["playpause", "pause", "next", "previous"]) } },
    async ({ action }) => text(describe(await command(deps, { cmd: action }))));

  add("tonearm_transfer",
    { description: "Move what is playing to another zone, keeping the track and position.",
      inputSchema: { to_zone: z.string().describe("Destination zone name") } },
    async ({ to_zone }) => {
      const status = await readStatus(deps);
      const zone = resolveZone(status.zones, to_zone);
      return text(describe(await command(deps, { cmd: "transfer", arg: zone.id })));
    });

  add("tonearm_pin",
    { description: "Change which zone the bar widget follows. Pass 'unpin' to resume auto-follow.",
      inputSchema: { zone: z.string().describe("A zone name, or 'unpin'") } },
    async ({ zone }) => {
      if (String(zone).trim().toLowerCase() === "unpin") {
        return text(describe(await command(deps, { cmd: "zone", arg: "unpin" })));
      }
      const status = await readStatus(deps);
      const target = resolveZone(status.zones, zone);
      return text(describe(await command(deps, { cmd: "zone", arg: target.id })));
    });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer({ request: socketRequest });
  await server.connect(new StdioServerTransport());
}
