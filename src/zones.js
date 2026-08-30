export class UnknownZoneError extends Error {
  constructor(name, available) {
    super(`no zone named ${JSON.stringify(name)}. Available: ${available.join(", ") || "none"}`);
    this.available = available;
  }
}

export function resolveZone(zones, name) {
  const list = Array.isArray(zones) ? zones : [];
  const wanted = String(name ?? "").trim().toLowerCase();
  const hit = list.find(
    (z) => String(z.id) === String(name ?? "").trim() ||
           String(z.name ?? "").toLowerCase() === wanted,
  );
  if (!hit) throw new UnknownZoneError(name, list.map((z) => z.name));
  return { id: hit.id, name: hit.name };
}
