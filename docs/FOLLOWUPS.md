# Follow-ups

Known gaps in this server, with enough context to act on each without
re-deriving it. Roughly ordered by whether a user can notice.

**The numbers are permanent identifiers, not positions.** A closed item's
number is retired rather than reused, so the sequence is expected to grow gaps.
Closed items are recorded at the bottom so a future reader does not re-open
them.

Gaps in `tonearmd` itself live in
[tonearm's own follow-ups](https://github.com/ssandys/tonearm/blob/master/docs/FOLLOWUPS.md).

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
