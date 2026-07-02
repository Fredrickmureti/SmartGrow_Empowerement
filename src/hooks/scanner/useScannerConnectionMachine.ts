/**
 * useScannerConnectionMachine — Plan P3.
 *
 * Authoritative, intent-aware derivation of the user-facing scanner
 * connection label. Replaces the 4-state `useScannerHealth` collapse
 * (`ok | degraded | down | revoked`) which conflated browser online,
 * realtime channel state, last-broadcast age, pairing presence, and
 * revocation into one bucket.
 *
 * Inputs are raw signals — the callers must NOT pre-collapse them.
 * Output label is the only thing UI should switch on.
 *
 *   ok                — channel SUBSCRIBED, last broadcast < 30 s
 *   paired_idle       — SUBSCRIBED, last broadcast ≥ 30 s (no scans is fine)
 *   reconnecting      — channel CLOSED/CHANNEL_ERROR/connecting, online
 *   sync_delayed      — SUBSCRIBED but last broadcast ≥ 60 s AND phone queued
 *   offline_queueing  — !navigator.onLine OR REST ping failed
 *   session_expired   — pairing row gone (claimed-then-deleted server-side)
 *   revoked           — revokedAt set (terminal, takes precedence)
 *
 * Precedence (highest first): revoked → session_expired → offline_queueing
 * → reconnecting → sync_delayed → paired_idle → ok.
 *
 * Transitions emit on a 2 s sticky window — callers that want to toast on
 * a transition should compare `label` across renders and only act when
 * `since` advances past 2000 ms.
 *
 * Pure derivation lives in `deriveScannerConnection`; the hook is a thin
 * wrapper that re-ticks at 1 Hz to age the broadcast/queue timers.
 *
 * Locked by `src/test/scanner/connection-machine.test.ts`.
 */

import { useEffect, useRef, useState } from "react";

export type ScannerChannelTransport =
  | "connecting"
  | "subscribed"
  | "closed"
  | "channel_error"
  | "timed_out";

export type ScannerConnectionLabel =
  | "ok"
  | "paired_idle"
  | "reconnecting"
  | "sync_delayed"
  | "offline_queueing"
  | "session_expired"
  | "revoked";

export interface ScannerConnectionInputs {
  /** Browser connectivity. Pass `true` from contexts where it's not measurable. */
  online: boolean;
  /** Raw realtime channel state — do NOT pre-map to "ok/degraded". */
  channelTransport: ScannerChannelTransport;
  /** Wall-clock ms of the last broadcast we received (any event). Null if never. */
  lastBroadcastAt: number | null;
  /** Whether the pairing row still exists server-side. */
  pairingRowExists: boolean;
  /** Wall-clock ms when `revoked_at` was observed. Terminal. */
  revokedAt: number | null;
  /** Last REST ping result (debounced 10 s by the caller). Null = unknown. */
  restReachable: boolean | null;
  /** Queued scans pending broadcast (phone side). 0 if unknown / desk side. */
  phoneQueueDepth: number;
}

export interface ScannerConnectionState {
  label: ScannerConnectionLabel;
  /** Free-form sub-reason for diagnostics. Not for UI switching. */
  subreason: string;
  /** Wall-clock ms when this label was first entered (for sticky-window UX). */
  since: number;
}

export const OK_FRESHNESS_MS = 30_000;
export const SYNC_DELAYED_MS = 60_000;
export const STICKY_TRANSITION_MS = 2_000;

export function deriveScannerConnection(
  inputs: ScannerConnectionInputs,
  now: number,
): { label: ScannerConnectionLabel; subreason: string } {
  // 1. Terminal: revoked.
  if (inputs.revokedAt !== null) {
    return { label: "revoked", subreason: "session_revoked" };
  }
  // 2. Server-side pairing row gone — phone must re-pair.
  if (!inputs.pairingRowExists) {
    return { label: "session_expired", subreason: "pairing_row_missing" };
  }
  // 3. No network OR REST proven unreachable — queue locally.
  if (!inputs.online || inputs.restReachable === false) {
    return {
      label: "offline_queueing",
      subreason: !inputs.online ? "navigator_offline" : "rest_unreachable",
    };
  }
  // 4. Channel not subscribed — reconnecting.
  if (inputs.channelTransport !== "subscribed") {
    return {
      label: "reconnecting",
      subreason: `channel_${inputs.channelTransport}`,
    };
  }
  // From here: online, subscribed, paired, not revoked.
  const ageMs = inputs.lastBroadcastAt === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, now - inputs.lastBroadcastAt);
  // 5. Subscribed but stale AND phone has queued work — delivery is lagging.
  if (ageMs >= SYNC_DELAYED_MS && inputs.phoneQueueDepth > 0) {
    return { label: "sync_delayed", subreason: `silent_${Math.floor(ageMs / 1000)}s_queue_${inputs.phoneQueueDepth}` };
  }
  // 6. Subscribed but no recent traffic — paired and idle (not a problem).
  if (ageMs >= OK_FRESHNESS_MS) {
    return { label: "paired_idle", subreason: `silent_${Math.floor(ageMs / 1000)}s` };
  }
  return { label: "ok", subreason: "fresh" };
}

export function useScannerConnectionMachine(inputs: ScannerConnectionInputs): ScannerConnectionState {
  // Re-tick every 1 s to age the broadcast/queue timers without requiring
  // callers to set state on a timer themselves.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) & 0xffff), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const derived = deriveScannerConnection(inputs, now);

  // Track the wall-clock ms when `label` was first entered. Resets on transition.
  const sinceRef = useRef<{ label: ScannerConnectionLabel; at: number }>({
    label: derived.label,
    at: now,
  });
  if (sinceRef.current.label !== derived.label) {
    sinceRef.current = { label: derived.label, at: now };
  }

  return {
    label: derived.label,
    subreason: derived.subreason,
    since: sinceRef.current.at,
  };
}
