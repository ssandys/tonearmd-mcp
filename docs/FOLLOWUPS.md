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

Doing it also closes item 9's LRU cap, since per-session zones make the fixed
eight-slot bound in `src/sessions.js` unnecessary.

Deferred until `tonearmd` moves to its own repository, at which point the
daemon-side changes stop being cross-repo work.

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
