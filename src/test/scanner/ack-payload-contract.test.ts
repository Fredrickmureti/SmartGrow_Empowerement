/**
 * Scanner ACK payload zod-contract test.
 * Locks the ACK / revoke / ping / pong wire format so a future field
 * rename (or accidental removal of `.optional()`) cannot silently break
 * back-compat between desk-side senders and phone-side parsers.
 */

import { describe, it, expect } from "vitest";
import {
  ackPayloadSchema,
  revokePayloadSchema,
  pingPayloadSchema,
  pongPayloadSchema,
  safeParseAck,
  safeParseRevoke,
  safeParsePing,
  safeParsePong,
  SCAN_EVENTS,
} from "@/services/scanner/ackPayload";

describe("ack payload contract", () => {
  it("parses a minimal ACK (old phone, no workflow/field_label)", () => {
    const parsed = safeParseAck({ code: "1234", kind: "ok", at: 1 });
    expect(parsed).not.toBeNull();
    expect(parsed?.workflow).toBeUndefined();
    expect(parsed?.field_label).toBeUndefined();
  });

  it("parses a full ACK with workflow + field_label", () => {
    const parsed = safeParseAck({
      code: "9999",
      kind: "weighted",
      detail: "1.20 kg",
      at: 2,
      workflow: "count",
      field_label: "Bin A12",
    });
    expect(parsed?.workflow).toBe("count");
    expect(parsed?.field_label).toBe("Bin A12");
  });

  it.each(["ok", "weighted", "unknown", "error"] as const)(
    "accepts kind %s",
    (kind) => {
      expect(ackPayloadSchema.safeParse({ code: "x", kind, at: 0 }).success).toBe(true);
    },
  );

  it("rejects unknown kind", () => {
    expect(safeParseAck({ code: "x", kind: "bogus", at: 0 })).toBeNull();
  });

  it("rejects empty code", () => {
    expect(safeParseAck({ code: "", kind: "ok", at: 0 })).toBeNull();
  });

  it("rejects negative at", () => {
    expect(safeParseAck({ code: "x", kind: "ok", at: -1 })).toBeNull();
  });

  it("parses revoke without reason (back-compat)", () => {
    expect(safeParseRevoke({ at: 0 })?.reason).toBeUndefined();
  });

  it("parses revoke with each reason", () => {
    for (const reason of [
      "manual",
      "business_changed",
      "branch_changed",
      "expired",
      "session_replaced",
    ] as const) {
      const r = safeParseRevoke({ at: 1, reason });
      expect(r?.reason).toBe(reason);
    }
  });

  it("rejects revoke with bogus reason", () => {
    expect(safeParseRevoke({ at: 1, reason: "nope" })).toBeNull();
  });

  it("ping / pong round-trip preserves id", () => {
    const ping = pingPayloadSchema.parse({ id: "p1", at: 10 });
    const pong = pongPayloadSchema.parse({ id: ping.id, ping_at: ping.at, at: 20 });
    expect(safeParsePing(ping)).toEqual(ping);
    expect(safeParsePong(pong)).toEqual(pong);
  });

  it("rejects pong with missing id", () => {
    expect(safeParsePong({ ping_at: 1, at: 2 })).toBeNull();
  });

  it("exports stable broadcast event names", () => {
    expect(SCAN_EVENTS).toEqual({
      scan: "scan",
      ack: "ack",
      revoke: "revoke",
      ping: "ping",
      pong: "pong",
    });
  });
});