/**
 * channelStateTruth — pure helpers for deriving the phone cockpit's
 * channel pill state from Supabase Realtime callback events plus
 * inbound traffic.
 *
 * Background: the per-channel `.subscribe()` callback emits transient
 * `CLOSED` / `CHANNEL_ERROR` on tab backgrounding, JWT refresh, and
 * short network blips — even when broadcasts (ACK, ping) keep arriving
 * milliseconds later on the next subscribe. The naive approach of
 * flipping straight to "reconnecting" on any non-SUBSCRIBED event
 * makes a healthy session appear to flap.
 *
 * Two rules collapse the visible flap to zero for the common <1 s
 * re-subscribe path without sacrificing the real multi-second outage
 * signal:
 *
 *   1. INBOUND-TRAFFIC UPGRADE — any inbound event (ack, ping, revoke
 *      consumer, etc.) is proof the channel is delivering; promote
 *      `connecting` / `reconnecting` → `connected`. `revoked` is
 *      terminal and never upgraded.
 *
 *   2. DEBOUNCED DOWN-FLIP — on `CLOSED` / `CHANNEL_ERROR` /
 *      `TIMED_OUT`, do NOT flip to `reconnecting` immediately. Arm a
 *      timer (default 1500 ms). If the next `SUBSCRIBED` or inbound
 *      event arrives first, cancel the timer and stay green.
 *
 * Both behaviours are exercised by `channel-state-truth.test.ts`.
 */

export type PillState = "connecting" | "connected" | "reconnecting" | "revoked";

/** Inbound-traffic upgrade rule. Returns the next pill state. */
export function promoteOnInbound(current: PillState): PillState {
  if (current === "revoked") return "revoked";
  if (current === "connected") return "connected";
  return "connected";
}

export const DOWN_FLIP_DELAY_MS = 1500;
