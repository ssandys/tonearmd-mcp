export class BadRefError extends Error {}

export function encodeRef({ query, category, index, title }) {
  return Buffer.from(JSON.stringify({ query, category, index, title })).toString("base64url");
}

export function decodeRef(encoded) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(encoded), "base64url").toString("utf8"));
  } catch {
    throw new BadRefError("that is not a ref this server issued");
  }
  const ok =
    parsed !== null && typeof parsed === "object" &&
    typeof parsed.query === "string" &&
    typeof parsed.category === "string" &&
    Number.isInteger(parsed.index) &&
    typeof parsed.title === "string";
  if (!ok) throw new BadRefError("that is not a ref this server issued");
  const { query, category, index, title } = parsed;
  return { query, category, index, title };
}
