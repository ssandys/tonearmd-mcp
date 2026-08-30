import { TIMEOUTS } from "./client.js";
import { decodeRef } from "./codec.js";
import { EXPANDABLE, categoryIndex, buildCandidates } from "./candidates.js";

export class RefStaleError extends Error {}
export class DaemonRefusedError extends Error {}

const SESSION = "mcp";
const browse = (deps, op, extra = {}) =>
  deps.request({ cmd: "browse", session: SESSION, op, ...extra },
               { timeoutMs: TIMEOUTS.browse });

function assertOk(reply, what) {
  if (reply && reply.ok === false) {
    throw new DaemonRefusedError(reply.message || `${what} failed (${reply.error})`);
  }
  return reply;
}

// search -> for each expandable category, enter it, read its rows, come back.
//
// `level` is reassigned from every reply and never cached. MEASURED
// 2026-08-30: back() BUMPS the generation counter rather than restoring the
// old one -- search gave level_id 7, entering Albums 8, and coming back 9, not
// 7. Reusing the original search level_id for the second category returns
// `stale`, so this loop would have yielded albums and never tracks.
export async function searchLibrary(query, deps) {
  let level = assertOk(await browse(deps, "search", { term: query }), "search");
  const byCategory = {};
  for (const category of EXPANDABLE) {
    const index = categoryIndex(level, category);
    if (index === null) continue;
    const entered = assertOk(
      await browse(deps, "enter", { index, level_id: level.level_id }), "enter");
    byCategory[category] = entered.rows ?? [];
    level = assertOk(await browse(deps, "back"), "back");
  }
  return buildCandidates(query, byCategory);
}

// A fresh walk every time. Holding a level across a Claude turn -- which can
// be minutes -- is the staleness that caused real widget bugs.
export async function playRef(refString, deps) {
  const ref = decodeRef(refString);
  const search = assertOk(await browse(deps, "search", { term: ref.query }), "search");

  const categoryAt = categoryIndex(search, ref.category);
  if (categoryAt === null) {
    throw new RefStaleError(`the ${ref.category} results are no longer there; search again`);
  }
  const level = assertOk(
    await browse(deps, "enter", { index: categoryAt, level_id: search.level_id }), "enter");

  const row = (level.rows ?? [])[ref.index];
  if (!row || row.title !== ref.title) {
    throw new RefStaleError(
      `the results moved: expected ${JSON.stringify(ref.title)} at position ${ref.index}, ` +
      `found ${JSON.stringify(row?.title ?? "nothing")}. Search again and retry.`);
  }

  const played = assertOk(
    await browse(deps, "activate", { index: ref.index, level_id: level.level_id }), "play");
  if (played.played !== true) {
    throw new DaemonRefusedError(`${ref.title} did not start playing`);
  }
  return { title: row.title, subtitle: row.subtitle || null };
}
