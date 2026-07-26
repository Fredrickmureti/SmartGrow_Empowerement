/**
 * Nonce replay-cache for mutating agent routes.
 *
 * Callers include `X-Edge-Nonce: <uuid>` on mutating requests. The
 * cache remembers each nonce for TTL_MS and rejects duplicates so a
 * captured request cannot be replayed against the loopback listener.
 *
 * Purely in-memory: process restart invalidates the cache, which is
 * acceptable because bearer tokens rotate on restart in Phase 2.
 */

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;

const seen = new Map<string, number>();

function sweep(now: number) {
  if (seen.size < MAX_ENTRIES) return;
  for (const [k, exp] of seen) {
    if (exp <= now) seen.delete(k);
  }
}

/** Returns true if the nonce is fresh (and records it); false on replay. */
export function acceptNonce(nonce: string | undefined | null): boolean {
  if (!nonce || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
    return false;
  }
  const now = Date.now();
  const existing = seen.get(nonce);
  if (existing && existing > now) return false;
  sweep(now);
  seen.set(nonce, now + TTL_MS);
  return true;
}
