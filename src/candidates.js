import { encodeRef } from "./codec.js";

// Albums and Tracks are the two categories that play. Artists is two levels
// from anything playable; Composers and Works are classical-specific.
export const EXPANDABLE = ["Albums", "Tracks"];
export const PER_CATEGORY_CAP = 10;

const KIND = { Albums: "album", Tracks: "track" };

// Matched on TITLE, not on can_play. Measured 2026-08-30: can_play is true on
// every row of a successful search, including the category headers, so it
// cannot identify a playable item. Confirms browse design 2.4.
export function categoryIndex(searchReply, category) {
  const rows = searchReply?.rows ?? [];
  const i = rows.findIndex((r) => r.title === category);
  return i === -1 ? null : i;
}

export function buildCandidates(query, byCategory) {
  const out = [];
  for (const category of EXPANDABLE) {
    const rows = byCategory?.[category] ?? [];
    rows.slice(0, PER_CATEGORY_CAP).forEach((row, index) => {
      out.push({
        ref: encodeRef({ query, category, index, title: row.title }),
        kind: KIND[category],
        title: row.title,
        subtitle: row.subtitle || null,
      });
    });
  }
  return out;
}
