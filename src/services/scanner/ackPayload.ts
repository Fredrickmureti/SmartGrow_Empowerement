/**
 * ackPayload — single source of truth for the scanner ACK / control
 * broadcast contracts.
 *
 * Both the desk-side senders (`useScanChannel`, `usePOSScannerChannel`)
 * and the phone-side receiver (`MobileScannerPage`) MUST import the
 * parsers from this file. New optional fields are additive — old
 * payloads that omit them still parse, so a stale phone tab does not
 * break when the desktop ships a newer field.
 *
 * Schema covers four broadcast events:
 *  - "ack"     — per-scan verdict (ok / weighted / unknown / error)
 *  - "revoke"  — desk-side disconnected this pairing
 *  - "ping"    — desk asks phone to round-trip a heartbeat
 *  - "pong"    — phone replies, echoing the desk's `at` so RTT can be derived
 */

import { z } from "zod";

/** Verdict kinds the phone visually distinguishes. */
export const ackKindSchema = z.enum(["ok", "weighted", "unknown", "error"]);
export type AckKind = z.infer<typeof ackKindSchema>;

/** Workflow tag mirrored from the desk's focused scan target. */
export const ackWorkflowSchema = z.enum(["identity", "quantity", "count", "receive"]);
export type AckWorkflow = z.infer<typeof ackWorkflowSchema>;

/** Per-scan verdict broadcast (event="ack"). */
export const ackPayloadSchema = z.object({
  code: z.string().min(1),
  kind: ackKindSchema,
  detail: z.string().nullable().optional(),
  at: z.number().int().nonnegative(),
  /** S3 — workflow chip. */
  workflow: ackWorkflowSchema.optional(),
  field_label: z.string().max(120).optional(),
});
export type AckPayload = z.infer<typeof ackPayloadSchema>;

/** Reasons the workspace might revoke a pairing. */
export const revokeReasonSchema = z.enum([
  "manual",
  "business_changed",
  "branch_changed",
  "expired",
  "session_replaced",
]);
export type RevokeReason = z.infer<typeof revokeReasonSchema>;

export const revokePayloadSchema = z.object({
  at: z.number().int().nonnegative(),
  reason: revokeReasonSchema.optional(),
});
export type RevokePayload = z.infer<typeof revokePayloadSchema>;

/** Desk → phone heartbeat. */
export const pingPayloadSchema = z.object({
  /** Monotonic id so a phone can match concurrent pings. */
  id: z.string().min(1),
  at: z.number().int().nonnegative(),
});
export type PingPayload = z.infer<typeof pingPayloadSchema>;

/** Phone → desk reply; echoes the desk's `at`. */
export const pongPayloadSchema = z.object({
  id: z.string().min(1),
  /** echoed desk-stamp from the ping. */
  ping_at: z.number().int().nonnegative(),
  /** phone-stamp when the pong was sent. */
  at: z.number().int().nonnegative(),
});
export type PongPayload = z.infer<typeof pongPayloadSchema>;

/** Convenience parsers that never throw — return null on shape mismatch. */
export function safeParseAck(input: unknown): AckPayload | null {
  const r = ackPayloadSchema.safeParse(input);
  return r.success ? r.data : null;
}
export function safeParseRevoke(input: unknown): RevokePayload | null {
  const r = revokePayloadSchema.safeParse(input);
  return r.success ? r.data : null;
}
export function safeParsePing(input: unknown): PingPayload | null {
  const r = pingPayloadSchema.safeParse(input);
  return r.success ? r.data : null;
}
export function safeParsePong(input: unknown): PongPayload | null {
  const r = pongPayloadSchema.safeParse(input);
  return r.success ? r.data : null;
}

/** Stable broadcast event names — referenced in tests + both sides. */
export const SCAN_EVENTS = {
  scan: "scan",
  ack: "ack",
  revoke: "revoke",
  ping: "ping",
  pong: "pong",
} as const;
