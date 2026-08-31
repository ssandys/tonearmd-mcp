# Follow-ups

Known gaps in this server, with enough context to act on each without
re-deriving it. Roughly ordered by whether a user can notice.

**The numbers are permanent identifiers, not positions.** A closed item's
number is retired rather than reused, so the sequence is expected to grow gaps.
Closed items are recorded at the bottom so a future reader does not re-open
them.

Gaps in `tonearmd` itself live in
[tonearm's own follow-ups](https://github.com/ssandys/tonearm/blob/master/docs/FOLLOWUPS.md).

## 2. Every HTTP session shares one zone

`tonearmd` has one followed zone, one pin and one transport state, so several
MCP sessions driving it at once get one zone and a fight over it. `tonearm_pin`
over HTTP also still writes `pinned_zone_id` to `~/.config/tonearm/config.json`
— a remote call repoints the bar widget on the tonearm machine. For one person
on several machines that is the wanted behaviour; for two people it is not.

The upgrade is half-built already. `BrowseSession.__init__` takes a
`zone_id_provider` — a callable, per session, deliberately read at call time so
a repin between browses is honoured (`browse.py:160-168`) — and `core.py:590`
currently hands every session the same global `selected_zone_id`. Making it
per-session is a small daemon change.

What is not built is the transport half: `command(verb, arg)` (`core.py:616`)
acts on the followed zone and takes no zone argument, so `playpause` / `pause` /
`next` / `previous` would stay global. A session that starts music in its own
zone but pauses the widget's is worse than not having the feature, because it
looks like it works. Both halves or neither.

Doing it also closes tonearm's FOLLOWUPS item 9's LRU cap, since per-session
zones make the fixed eight-slot bound in `src/sessions.js` unnecessary.

Deferred until `tonearmd` moves to its own repository, at which point the
daemon-side changes stop being cross-repo work.

## 3. Liveness is tracked for GET streams only

`openStreams` in `src/http.js` counts only the standalone SSE notification
stream (opened via GET), so a session with one of those open is never swept
as idle no matter how long it has been since its last POST. The reverse is
not built: an in-flight POST is not itself treated as a liveness signal, so
a request slower than `ttlMs` could be swept mid-flight — `drop()` releases
its slot and closes its transport out from under a response that is still
being written.

Not reachable today. The slowest tool is a library search — up to 5 browse
operations at up to 25s each (`TIMEOUTS.browse` in `src/client.js`), about
130s worst case — against the 600s default `ttlMs` (`SESSION_TTL_MS` in
`src/http.js`), 4.6x headroom.

Worth recording anyway because the invariant that keeps this safe is
timing-derived, not structural: nothing in the code prevents a tool from
running longer than `ttlMs`. If any tool gets slower — a slower category
descent, a daemon that takes longer to reply, another entry added to
`EXPANDABLE` — this breaks silently. No test would fail and no error would
appear; a request would simply be cut off mid-flight the next time it
happened to run long enough.

Closing it means treating "has an in-flight request" as a liveness signal
alongside "has an open GET stream" — bumping `lastSeen` (or an equivalent
per-session in-flight counter) around every POST dispatch, not only once the
body has finished and a response is on its way back.

## 4. Graceful shutdown would block on a connected SSE client

There is no SIGTERM or SIGINT handler anywhere in `src/server.js`, and
`server.close()` is never called, so under systemd (or a plain `Ctrl-C`) the
process is simply killed and its sockets torn down by the OS.

If graceful shutdown is ever added, calling `http.Server#close()` on its own
is not safe here: `close()` stops the server accepting new connections but
waits for every open connection to end on its own before its callback fires.
A connected SSE notification stream (the same GET stream item 3 above
discusses) has no reason to ever end on its own — staying open is the whole
point of it — so `close()` would block indefinitely rather than returning
promptly, unlike the ~3s an aborted ordinary socket takes to time out.

The remedy is the fix the test suite's own teardown already applies (see
`listening()` in `test/http.test.js`): call `server.closeAllConnections()`
immediately before `server.close()`, forcing any connections still open
rather than waiting for them to close on their own.

## Closed

Recorded so they are not re-opened.

- **1. The pin was never reported, and pinning mis-reported itself.**
  `describe()` rendered `name: state, playing X` and dropped `zone.pinned` —
  which the daemon returns in every status reply — so an agent that could
  *set* the pin with `tonearm_pin` could not read it back; answering "which
  zone is pinned" meant shelling out to `tonearmctl status`.

  The same gap made a successful pin report as a failure. `command()` polls a
  per-verb `SETTLED` predicate, and `zone` had no entry, so it fell to the
  default `changed` — `[zone.id, zone.state, now_playing.title]`. Pinning the
  already-followed zone moves none of those, so the poll ran its full 3s and
  emitted "Sent pin to X, but the zone had not reflected it after 3s" over a
  pin that was applied. `unpin` had the mirror fault: a track changing while
  it was in flight satisfied `changed`, stopping the poll early on a zone that
  was still pinned.

  Both halves closed on the field the daemon already sends. `describe()` now
  reports `(pinned)` or `(auto-follow)` — the latter is not filler, it says the
  zone may change on its own before the next tool call. `SETTLED.zone` asserts
  `zone.pinned` matches what was asked, which required passing the payload to
  the predicates. Measured live 2026-08-30 against a running daemon: the
  idempotent pin, the unpin and the re-pin each confirm in ~53ms, where the
  first previously took 3s and reported the opposite of the truth.
