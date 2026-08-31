# tonearmd-mcp over HTTP — design

**Date:** 2026-08-31
**Status:** approved, not yet implemented

Today `tonearmd-mcp` speaks MCP over stdio, which means the MCP client spawns
it as a child process on the same machine as `tonearmd`. This design adds a
Streamable HTTP transport so MCP clients elsewhere on the local network can
drive the same daemon, guarded by a shared key.

## 1. Scope

**In:** a Streamable HTTP transport alongside stdio; a shared-key auth gate; a
`systemd --user` unit; per-session browse cursors over a bounded key space.

**Out:** per-session *zone* targeting. Every session drives the one zone the
widget is following, last writer wins, exactly as today. See §8.

**Audience:** one person, several machines, one at a time in practice. This is
sized for that and says so wherever the sizing shows.

## 2. Where the network boundary goes

The boundary is `tonearmd-mcp`, not `tonearmd`.

`tonearmd`'s authorization model *is* the filesystem: `AF_UNIX`, directory
`0700`, socket `0600` (`server.py:41-49`). There is no authentication in the
wire protocol, because "can open the socket" has always meant "is already you,
on this machine." Shipped decisions lean on that premise — `FOLLOWUPS` item 9
takes `multi_session_key` straight off the wire with no validation precisely
because "the realistic failure mode is a buggy consumer... not an attacker",
and item 3 lets a stalled client block every other subscriber under a lock.

Putting `tonearmd` on a TCP port makes both of those attacker-reachable. The
MCP server's surface is six typed tools; the daemon's is a raw JSON protocol
with browse ops and an unvalidated session key. Exposing the narrow one and
leaving the daemon's premise intact is the whole design.

Consequence: `tonearmd` is unchanged by this work. Every file below is in
`tonearmd-mcp`.

## 3. Transport and process model

`buildServer()` is untouched. Only the entry point at the bottom of
`src/server.js` branches:

- **Default: stdio.** Existing local configs and all 51 existing tests keep
  working unchanged.
- **`--http [host:]port`** (env `TONEARM_MCP_HTTP`) starts an HTTP listener
  instead. Bare `--http` means `0.0.0.0:9340`; an argument overrides either
  half. Binding every interface is the point of the flag, and it is inert until
  the flag is passed. The port is clear of Roon's 9150/9330; `tonearmd` itself
  binds no TCP port, so nothing collides.

Stateful mode, `sessionIdGenerator: () => randomUUID()`. §5 hangs the browse
key on it.

Plain `node:http`. `express` and `hono` are present as transitive dependencies
of the MCP SDK; depending on a transitive is a trap, and the transport's
`handleRequest(req, res)` takes Node's `IncomingMessage`/`ServerResponse`
directly.

### The systemd unit is a consequence, not a choice

In stdio mode nothing runs until a client spawns it, and the client kills it on
exit. In HTTP mode a model on another machine cannot spawn a process here — it
sends a request to a URL, so something must already be listening before it
connects and still be listening after it disconnects. That is what a service
manager is for.

```ini
[Unit]
Description=tonearmd-mcp — MCP server for tonearmd, over HTTP
After=tonearmd.service
Wants=tonearmd.service

[Service]
Type=simple
ExecStart=/usr/bin/node %h/Src/tonearmd-mcp/src/server.js --http
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`After=` is politeness, not correctness: the server opens a fresh unix
connection per request, so a not-yet-running daemon reads as "tonearmd is not
running" until it is up. Ordering only avoids a confusing window at login.

No `RuntimeDirectory=`. `tonearmd.service` has one because systemd owns the
socket directory; this server owns no runtime state — it is a client of that
socket.

## 4. Authentication

One shared key, checked in middleware **before** `transport.handleRequest` sees
the request.

- `Authorization: Bearer <key>`.
- Stored at `~/.config/tonearm-mcp/key`, mode `0600` inside a `0700` directory
  — the same shape as `tonearmd`'s `TOKEN_PATH` and `_write_private`.
- Generated with `randomBytes` on first `--http` start if absent, printed once
  to stderr so it can be pasted into clients.
- Compared with `crypto.timingSafeEqual`, **guarding length first**: it throws
  on mismatched lengths rather than returning false, so an unguarded compare
  turns a short key from a rejection into a crash, reachable by anyone.
- Failure is a bare `401` with no detail about which part was wrong.

The key is never read in stdio mode. Local use is unaffected.

### Accepted risks, stated rather than solved

- **No TLS.** On a trusted home LAN a bearer key over plain HTTP is sniffable,
  and so is the listening history. Building TLS in means certificates every MCP
  client must trust — real work at the wrong layer. If the LAN stops being
  trusted, the answer is a reverse proxy terminating TLS in front of this, not
  TLS inside it.
- **DNS-rebinding protection via our own `Origin` check**, not the transport's
  `allowedHosts`/`allowedOrigins`, which are deprecated in SDK 1.30.0 in favour
  of external middleware. Largely belt-and-braces: a rebinding attack still
  cannot produce the bearer key.

## 5. Sessions and the bounded key space

The daemon already namespaces browse navigation by session key:
`cli.py:71` sends `session: "widget"`, `library.js:8` sends `session: "mcp"`,
`server.py:151` reads it, and `core.py:224,587-591` keeps one `BrowseSession`
per key in a dict. The widget and the MCP server already hold independent
cursors today. This is not a new mechanism — it is minting more keys in an
existing one.

Per-session keys are still wanted with a shared zone, because the isolation is
about *navigation*: two clients searching at once interleave their walks under
one key.

But a fresh key per session is exactly the unbounded growth item 9 warns about,
and the daemon has no "drop this session" verb, so a closed session would leak
its `BrowseSession` for the daemon's lifetime. Fixing that properly means an
LRU cap in `tonearmd` — the change this design exists to avoid.

**So bound the key space here instead.** Each MCP session maps to one of N
fixed slots (`mcp-0` … `mcp-7`), claimed on `onsessioninitialized` and released
on `onsessionclosed`, reused least-recently-first. The daemon sees at most
eight keys for all time regardless of how many sessions come and go. Exceeding
N concurrently makes two sessions share a cursor — degrading to today's
behaviour, not to corruption. N = 8 is chosen for one person on several
machines; it is a constant, not a computed bound.

Item 9's LRU cap remains the right long-term fix and rides with the §8
follow-up.

`SESSION` therefore stops being a module constant in `library.js` and becomes a
parameter threaded from the session, changing the `searchLibrary` / `playRef`
signatures. This is the one place the HTTP work reaches into existing tested
code rather than sitting beside it.

## 6. Error handling

- Daemon down already reads as prose through the registration-time guard;
  unchanged.
- Port already in use exits with a clear message, not a stack trace.
- An unparseable or unreadable key file is fatal at startup rather than
  silently falling back to no auth.

## 7. Testing

The existing 51 tests call `buildServer({request})` and never touch a
transport; they are untouched.

New coverage, real rather than mocked:

- **Auth:** missing header, malformed header, wrong key → 401; correct key →
  serves. Explicitly including a short key, which is the `timingSafeEqual`
  crash path.
- **Key file:** generated `0600` in a `0700` directory on first start; reused
  unchanged on second.
- **Slot mapping:** distinct sessions get distinct keys; a closed session's
  slot is reused; N+1 concurrent sessions collapse onto a slot rather than
  growing the map.
- **End-to-end:** a real `node:http` listener on an ephemeral port, a real
  `StreamableHTTPClientTransport` from the SDK, one `tonearm_status` round trip
  against a fake daemon socket. No new dependency — the SDK ships the client.

## 8. Deliberately deferred: per-session zones

Everything above shares one zone. There is one followed zone, one pin, one
transport state, so two sessions asking for music at once get one zone and a
fight over it. For one person on several machines that is correct and cheap.

The upgrade path is known and partly built. `BrowseSession.__init__` already
takes a `zone_id_provider` — a callable, per session, deliberately read at call
time so a repin between browses is honoured (`browse.py:160-168`). Today
`core.py:590` hands every session the same global `selected_zone_id`. Making it
per-session is a small daemon change, not an architectural one.

What is *not* built is the transport half: `command(verb, arg)`
(`core.py:616`) acts on the followed zone and takes no zone argument, so
`playpause` / `pause` / `next` / `previous` would stay global. A session that
can start music in its own zone but pauses the widget's is worse than not
having the feature, because it looks like it works. Per-session zones therefore
need both halves or neither.

`tonearm_pin` also splits in two under that design: over HTTP it should set the
calling session's target zone and touch no config, leaving
`~/.config/tonearm/config.json` to whoever is sitting at the machine. A model
on someone else's laptop repointing your bar widget is not a feature.

**Until then, `tonearm_pin` stays global over HTTP**, exactly as it is over
stdio: a remote call writes `pinned_zone_id` and repoints the bar widget on the
tonearm machine. For the stated audience — one person, several machines — that
is the desired behaviour rather than a defect, since there is only ever one
widget and one person moving it. It stops being acceptable the moment a second
person is on the LAN, which is the same trigger as the rest of this section.

This is recorded as `docs/FOLLOWUPS.md` item 2, to be taken up when `tonearmd`
moves to its own repository — at which point the daemon-side changes stop being
cross-repo work.

## 9. Files

| File | Change |
|---|---|
| `src/http.js` | new — listener, auth middleware, transport wiring |
| `src/sessions.js` | new — slot mapping |
| `src/server.js` | the `connect()` branch; thread the session key into library calls |
| `src/library.js` | `SESSION` constant becomes a parameter |
| `systemd/tonearmd-mcp.service` | new |
| `README.md` | HTTP mode, key setup, the LAN caveat |
| `docs/FOLLOWUPS.md` | item 2: per-session zones |

`tonearm` is untouched.
