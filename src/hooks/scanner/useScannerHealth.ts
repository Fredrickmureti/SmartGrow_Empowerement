/**
 * useScannerHealth — single derivation of the cockpit health pill,
 * reusable on both phone and desk. Avoids drifting truth between the
 * phone-side `MobileScannerPage` and desk-side pairing dialog.
 *
 * Inputs:
 *  - online        — navigator.onLine (or true on desk where it's implicit)
 *  - channelState  — realtime channel state
 *  - lastContactAt — wall-clock ms of last broadcast received (any event)
 *
 * Outputs:
 *  - health         — "ok" | "degraded" | "down" | "revoked"
 *  - lastContactAgo — seconds since last contact (re-ticks at 1 Hz)
 *
 * Semantics (locked by `src/test/scanner/health-derivation.test.ts`):
 *   revoked   → channel explicitly revoked by counterparty
 *   down      → device offline (no network at all)
 *   degraded  → channel reconnecting / connecting / silent > 8 s
 *   ok        → channel subscribed AND contact within 8 s
 */

import { useEffect, useState } from "react";

export type ScannerChannelState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "revoked";

export type ScannerHealth = "ok" | "degraded" | "down" | "revoked";

interface Args {
  online?: boolean;
  channelState: ScannerChannelState;
  lastContactAt: number | null;
}

const SILENCE_DEGRADED_MS = 8000;

export function deriveScannerHealth({
  online = true,
  channelState,
  lastContactAt,
  now,
}: Args & { now: number }): ScannerHealth {
  if (channelState === "revoked") return "revoked";
  if (!online) return "down";
  if (channelState !== "connected") return "degraded";
  if (lastContactAt && now - lastContactAt > SILENCE_DEGRADED_MS) return "degraded";
  return "ok";
}

export function useScannerHealth({ online = true, channelState, lastContactAt }: Args) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) & 0xffff), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const health = deriveScannerHealth({ online, channelState, lastContactAt, now });
  const lastContactAgo = lastContactAt ? Math.max(0, Math.floor((now - lastContactAt) / 1000)) : null;

  // Reference `tick` so React re-renders on the interval.
  void tick;

  return { health, lastContactAgo };
}
