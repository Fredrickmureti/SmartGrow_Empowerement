/**
 * deviceIdentity — Plan P4a.
 *
 * Stable per-device id for the phone-as-scanner page. The historical
 * implementation persisted in `sessionStorage`, which meant a page
 * refresh BURNED the id — desk-side dedupe was keyed on `(device_id,
 * seq)`, so the desk treated the post-refresh phone as a brand-new
 * device and the operator had to re-pair from scratch.
 *
 * This module promotes the id to `localStorage` (survives refresh and
 * tab close) while preserving the original "new tab = new device"
 * semantic only when the operator explicitly clears site data.
 *
 * Pure & storage-injectable so the migration path can be unit-tested
 * without a real browser.
 */

export const DEVICE_ID_KEY = "pos.scanner.deviceId.v2";
/** Pre-P4a key. We migrate the value forward then leave it for back-compat. */
export const LEGACY_SESSION_KEY = "pos.scanner.deviceId";

/**
 * P4b — trust token (rotating, hashed at rest server-side). Persisted on
 * the phone so a refreshed / temporarily-offline trusted device can
 * silently reclaim a fresh `scanner_sessions` row via
 * `scanner_reclaim_session` without operator re-pair.
 */
export const TRUST_TOKEN_KEY = "pos.scanner.trustToken.v1";

export type DeviceIdSource = "local" | "migrated" | "new";

export interface DeviceIdResolution {
  id: string;
  source: DeviceIdSource;
  /**
   * True when we observed the historical bug: a value existed in
   * `sessionStorage` (legacy) but NOT in `localStorage`. Used for the
   * `scanner.refresh_burned_token` counter so operations can see the
   * fix landing in the wild.
   */
  refreshBurnedToken: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Resolve (and persist) the device id. Idempotent: subsequent calls
 * return `source: "local"` once the localStorage value is set.
 */
export function resolveDeviceId(
  local: StorageLike,
  session: StorageLike,
): DeviceIdResolution {
  const existing = local.getItem(DEVICE_ID_KEY);
  if (existing) {
    return { id: existing, source: "local", refreshBurnedToken: false };
  }
  const legacy = session.getItem(LEGACY_SESSION_KEY);
  if (legacy) {
    // Carry the legacy id forward so the desk's `(device_id, seq)`
    // dedupe maps cleanly across the migration.
    local.setItem(DEVICE_ID_KEY, legacy);
    return {
      id: legacy,
      source: "migrated",
      // The legacy-only state is precisely the "refresh burned token"
      // condition we want to count.
      refreshBurnedToken: true,
    };
  }
  const id = makeId();
  local.setItem(DEVICE_ID_KEY, id);
  // Also write to sessionStorage for back-compat with any in-flight
  // tooling that still reads the old key.
  session.setItem(LEGACY_SESSION_KEY, id);
  return { id, source: "new", refreshBurnedToken: false };
}

/** P4b — read the stored trust token (returns null if missing/disabled). */
export function getTrustToken(local?: StorageLike): string | null {
  try {
    const s = local ?? (typeof window !== "undefined" ? window.localStorage : null);
    return s ? s.getItem(TRUST_TOKEN_KEY) : null;
  } catch { return null; }
}

/** P4b — persist a freshly-issued or rotated trust token. */
export function setTrustToken(token: string, local?: StorageLike): void {
  try {
    const s = local ?? (typeof window !== "undefined" ? window.localStorage : null);
    if (s) s.setItem(TRUST_TOKEN_KEY, token);
  } catch { /* storage disabled */ }
}

/** P4b — drop the local trust token (revoked / invalid / expired). */
export function clearTrustToken(local?: StorageLike): void {
  try {
    const s = local ?? (typeof window !== "undefined" ? window.localStorage : null);
    if (s && typeof s.removeItem === "function") s.removeItem(TRUST_TOKEN_KEY);
    else if (s) s.setItem(TRUST_TOKEN_KEY, "");
  } catch { /* storage disabled */ }
}
