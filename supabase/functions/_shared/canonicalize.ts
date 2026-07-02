/**
 * Deterministic JSON canonicalisation + sha-256 hashing of a localization
 * pack snapshot. Used to make pack re-publishes idempotent: republishing
 * the same content collapses onto the existing version row instead of
 * spawning duplicates.
 *
 * Deliberately strips volatile bookkeeping fields (created_at, updated_at,
 * id) from individual rows before hashing so the hash captures *semantic*
 * content only.
 */

const VOLATILE_KEYS = new Set([
  "id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "published_at",
  "published_by",
]);

function stripVolatile(node: any): any {
  if (Array.isArray(node)) return node.map(stripVolatile);
  if (node && typeof node === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(node).sort()) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(node[k]);
    }
    return out;
  }
  return node;
}

/** Canonical JSON: sorted keys, volatile fields removed, stable separators. */
export function canonicalizeSnapshot(snapshot: any): string {
  return JSON.stringify(stripVolatile(snapshot));
}

/** SHA-256 hex digest of the canonical snapshot. */
export async function hashSnapshot(snapshot: any): Promise<string> {
  const enc = new TextEncoder().encode(canonicalizeSnapshot(snapshot));
  const digest = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}
