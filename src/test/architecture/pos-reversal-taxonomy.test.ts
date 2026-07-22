/**
 * Contract test for Stage 2 of the POS refund/reversal remediation
 * (see `.lovable/plan.md`).
 *
 * Locks in five architectural invariants for the reversal domain
 * taxonomy:
 *
 * 1. The command discriminator union covers exactly the six commands
 *    the plan enumerates — no more, no less.
 * 2. Every command has a canonical `business_event_outbox` topic.
 * 3. Every reason code is usable by at least one command (no orphans).
 * 4. Every command has at least one reason code assigned (no gaps).
 * 5. The ADR-0012 payment reversal reasons are a subset of the POS
 *    canonical vocabulary (Stage 2 unification requirement).
 */
import { describe, it, expect } from "vitest";
import {
  POS_REVERSAL_REASON_CODES,
  REASON_METADATA,
  POS_REVERSAL_EVENT_TOPICS,
  getReasonsForCommand,
  assertReasonAllowedForCommand,
  toAccountingReason,
  type POSReversalCommandType,
  type POSReversalReasonCode,
} from "@/services/pos/reversal";

const ALL_COMMANDS: readonly POSReversalCommandType[] = [
  "void_sale",
  "reverse_card_authorization",
  "refund_sale",
  "return_goods",
  "exchange",
  "issue_store_credit",
] as const;

const ADR_0012_REASONS = [
  "data_entry_error",
  "duplicate_payment",
  "bank_transfer_failed",
  "wrong_invoice_applied",
  "customer_refund_requested",
  "invoice_cancelled_keep_as_credit",
  "invoice_cancelled_keep_as_advance",
  "pre_refund_unapply",
  "payment_currency_mismatch",
] as const;

describe("Stage 2 — POS reversal taxonomy contract", () => {
  it("event topics cover exactly the six commands", () => {
    const topicCommands = Object.keys(POS_REVERSAL_EVENT_TOPICS).sort();
    expect(topicCommands).toEqual([...ALL_COMMANDS].sort());
  });

  it("every command has at least one reason code", () => {
    for (const command of ALL_COMMANDS) {
      const reasons = getReasonsForCommand(command);
      expect(
        reasons.length,
        `command "${command}" has no reasons assigned`,
      ).toBeGreaterThan(0);
    }
  });

  it("no reason code is orphaned (each maps to >= 1 command)", () => {
    for (const code of POS_REVERSAL_REASON_CODES) {
      expect(
        REASON_METADATA[code].allowedCommands.length,
        `reason "${code}" is orphaned (allowedCommands is empty)`,
      ).toBeGreaterThan(0);
    }
  });

  it("ADR-0012 payment reversal reasons are all present in the POS taxonomy", () => {
    for (const legacy of ADR_0012_REASONS) {
      expect(
        POS_REVERSAL_REASON_CODES.includes(
          legacy as POSReversalReasonCode,
        ),
        `ADR-0012 reason "${legacy}" is missing from the POS taxonomy`,
      ).toBe(true);
    }
  });

  it("assertReasonAllowedForCommand rejects mismatches", () => {
    // `card_auth_timeout` is card-only — refund_sale must reject it.
    expect(() =>
      assertReasonAllowedForCommand("card_auth_timeout", "refund_sale"),
    ).toThrow(/not permitted/);
    // `customer_refund_requested` is allowed on refund_sale.
    expect(() =>
      assertReasonAllowedForCommand("customer_refund_requested", "refund_sale"),
    ).not.toThrow();
  });

  it("finance mapping is exhaustive (no unmapped codes reach the payment leg silently)", () => {
    // Every code either maps to a legal ADR-0012 reason or returns null;
    // `toAccountingReason` must not throw for any known code.
    for (const code of POS_REVERSAL_REASON_CODES) {
      expect(() => toAccountingReason(code)).not.toThrow();
    }
    // Store credit reasons should NOT map (finance-leg is skipped).
    expect(toAccountingReason("goodwill_credit")).toBeNull();
    expect(toAccountingReason("loyalty_adjustment")).toBeNull();
    // Card-only reasons collapse to data_entry_error for the payment leg.
    expect(toAccountingReason("card_auth_timeout")).toBe("data_entry_error");
  });

  it("event topics follow the pos.<domain>.<past-tense-verb> pattern", () => {
    for (const topic of Object.values(POS_REVERSAL_EVENT_TOPICS)) {
      expect(topic).toMatch(/^pos\.[a-z_]+\.[a-z_]+$/);
    }
  });
});
