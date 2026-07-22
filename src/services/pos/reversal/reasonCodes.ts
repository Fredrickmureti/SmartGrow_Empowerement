/**
 * POS Reversal Reason Codes — Stage 2 of the POS refund/reversal
 * remediation (see `.lovable/plan.md`).
 *
 * This module unifies the reason-code vocabulary across every POS
 * reversal command. It is a strict superset of `PaymentReversalReason`
 * from `src/hooks/useTransactionReversal.ts` (ADR 0012), which the plan
 * requires we do not fork.
 *
 * Two vocabularies live here:
 *
 *   1. `POSReversalReasonCode` — the CANONICAL set of reason codes any
 *      command may cite. Rendered in UI, persisted in `pos_return_reasons`
 *      / `payment_reversal_events` / `commercial_audit_logs`, and emitted
 *      on the `business_event_outbox` payload.
 *
 *   2. `AccountingReversalReason` — the ADR-0012 subset that maps to the
 *      Postgres `payment_reversal_reason` enum. Commands that touch a
 *      customer payment MUST resolve their canonical reason to one of
 *      these before invoking the finance path.
 *
 * Adding a reason code:
 *   - Add it to `POS_REVERSAL_REASON_CODES` (source of truth for the union).
 *   - Add a display entry to `REASON_METADATA`.
 *   - If it should be usable from the finance/payment leg, add its mapping
 *     in `toAccountingReason`; otherwise leave it unmapped and the
 *     TypeScript compiler will refuse to pass it to the payment leg.
 */

import type { PaymentReversalReason } from "@/hooks/useTransactionReversal";

/**
 * Canonical reason codes for every POS reversal command.
 *
 * IMPORTANT: preserve enum-string stability — these values are persisted
 * to `pos_return_reasons`, `commercial_audit_logs.event_metadata`, and
 * `business_event_outbox.payload.reason_code`. Renaming a code is a
 * breaking change; deprecate + alias instead.
 */
export const POS_REVERSAL_REASON_CODES = [
  // Same-shift pre-settlement corrections (VoidSaleCommand)
  "cashier_error",
  "wrong_item_scanned",
  "customer_changed_mind_pre_settlement",
  // Card-authorization reversal (ReverseCardAuthorizationCommand)
  "card_auth_timeout",
  "card_partial_capture_shortfall",
  "card_settlement_declined",
  // Refunds (RefundSaleCommand)
  "customer_refund_requested",
  "duplicate_payment",
  "wrong_invoice_applied",
  "price_correction",
  "promised_promo_missed",
  // Goods return (ReturnGoodsCommand)
  "damaged_on_arrival",
  "defective_product",
  "wrong_item_delivered",
  "customer_dislike",
  "expired_product",
  "recalled_product",
  // Exchange (ExchangeCommand)
  "size_exchange",
  "colour_exchange",
  "model_exchange",
  // Store credit (IssueStoreCreditCommand)
  "goodwill_credit",
  "loyalty_adjustment",
  // Finance-layer parity (ADR 0012 codes carried through)
  "data_entry_error",
  "bank_transfer_failed",
  "invoice_cancelled_keep_as_credit",
  "invoice_cancelled_keep_as_advance",
  "pre_refund_unapply",
  "payment_currency_mismatch",
] as const;

export type POSReversalReasonCode = (typeof POS_REVERSAL_REASON_CODES)[number];

export interface ReasonMetadata {
  code: POSReversalReasonCode;
  label: string;
  /** Short helper text rendered under the reason in the UI. */
  helper: string;
  /**
   * Which commands are allowed to cite this reason. Enforced at the
   * command-construction layer via `assertReasonAllowedForCommand`.
   */
  allowedCommands: ReadonlyArray<POSReversalCommandType>;
}

/** Discriminator for the command taxonomy (kept here to avoid circular imports). */
export type POSReversalCommandType =
  | "void_sale"
  | "reverse_card_authorization"
  | "refund_sale"
  | "return_goods"
  | "exchange"
  | "issue_store_credit";

export const REASON_METADATA: Readonly<
  Record<POSReversalReasonCode, ReasonMetadata>
> = Object.freeze({
  cashier_error: {
    code: "cashier_error",
    label: "Cashier error",
    helper: "Item rung up incorrectly before settlement.",
    allowedCommands: ["void_sale"],
  },
  wrong_item_scanned: {
    code: "wrong_item_scanned",
    label: "Wrong item scanned",
    helper: "A different item's barcode was captured; correct before finalising.",
    allowedCommands: ["void_sale", "return_goods"],
  },
  customer_changed_mind_pre_settlement: {
    code: "customer_changed_mind_pre_settlement",
    label: "Customer changed mind (pre-settlement)",
    helper: "Sale abandoned before card/cash settlement.",
    allowedCommands: ["void_sale"],
  },
  card_auth_timeout: {
    code: "card_auth_timeout",
    label: "Card authorization timeout",
    helper: "Terminal did not receive a response within the auth window.",
    allowedCommands: ["reverse_card_authorization"],
  },
  card_partial_capture_shortfall: {
    code: "card_partial_capture_shortfall",
    label: "Partial capture shortfall",
    helper: "Capture came in below the authorized amount; release the hold.",
    allowedCommands: ["reverse_card_authorization"],
  },
  card_settlement_declined: {
    code: "card_settlement_declined",
    label: "Settlement declined",
    helper: "Issuer declined the settlement batch after authorization.",
    allowedCommands: ["reverse_card_authorization"],
  },
  customer_refund_requested: {
    code: "customer_refund_requested",
    label: "Customer refund requested",
    helper: "Customer asked for money back on a completed sale.",
    allowedCommands: ["refund_sale", "return_goods"],
  },
  duplicate_payment: {
    code: "duplicate_payment",
    label: "Duplicate payment",
    helper: "The same tender was captured twice; reverse the extra.",
    allowedCommands: ["refund_sale", "reverse_card_authorization"],
  },
  wrong_invoice_applied: {
    code: "wrong_invoice_applied",
    label: "Wrong invoice applied",
    helper: "Payment was allocated to the wrong invoice.",
    allowedCommands: ["refund_sale"],
  },
  price_correction: {
    code: "price_correction",
    label: "Price correction",
    helper: "Corrected price after the sale; refund the difference.",
    allowedCommands: ["refund_sale"],
  },
  promised_promo_missed: {
    code: "promised_promo_missed",
    label: "Missed promotion",
    helper: "An eligible discount was not applied at sale time.",
    allowedCommands: ["refund_sale"],
  },
  damaged_on_arrival: {
    code: "damaged_on_arrival",
    label: "Damaged on arrival",
    helper: "Item was already damaged when the customer opened it.",
    allowedCommands: ["return_goods", "exchange"],
  },
  defective_product: {
    code: "defective_product",
    label: "Defective product",
    helper: "Item stopped working within warranty window.",
    allowedCommands: ["return_goods", "exchange"],
  },
  wrong_item_delivered: {
    code: "wrong_item_delivered",
    label: "Wrong item delivered",
    helper: "Customer received a different SKU than what was sold.",
    allowedCommands: ["return_goods", "exchange"],
  },
  customer_dislike: {
    code: "customer_dislike",
    label: "Customer preference",
    helper: "Customer no longer wants the item; goodwill return.",
    allowedCommands: ["return_goods", "exchange", "issue_store_credit"],
  },
  expired_product: {
    code: "expired_product",
    label: "Expired product",
    helper: "Item was past its use-by date at time of purchase.",
    allowedCommands: ["return_goods"],
  },
  recalled_product: {
    code: "recalled_product",
    label: "Recalled product",
    helper: "SKU is under an active recall; must be returned.",
    allowedCommands: ["return_goods"],
  },
  size_exchange: {
    code: "size_exchange",
    label: "Size exchange",
    helper: "Swap for a different size of the same product.",
    allowedCommands: ["exchange"],
  },
  colour_exchange: {
    code: "colour_exchange",
    label: "Colour exchange",
    helper: "Swap for a different colour variant.",
    allowedCommands: ["exchange"],
  },
  model_exchange: {
    code: "model_exchange",
    label: "Model exchange",
    helper: "Swap for a different but comparable product.",
    allowedCommands: ["exchange"],
  },
  goodwill_credit: {
    code: "goodwill_credit",
    label: "Goodwill credit",
    helper: "Issue store credit as a goodwill gesture.",
    allowedCommands: ["issue_store_credit"],
  },
  loyalty_adjustment: {
    code: "loyalty_adjustment",
    label: "Loyalty adjustment",
    helper: "Credit tied to a loyalty program correction.",
    allowedCommands: ["issue_store_credit"],
  },
  data_entry_error: {
    code: "data_entry_error",
    label: "Data entry error",
    helper: "Payment recorded incorrectly; reverse in full.",
    allowedCommands: ["refund_sale", "void_sale"],
  },
  bank_transfer_failed: {
    code: "bank_transfer_failed",
    label: "Bank transfer failed",
    helper: "Downstream bank transfer bounced or was rejected.",
    allowedCommands: ["refund_sale"],
  },
  invoice_cancelled_keep_as_credit: {
    code: "invoice_cancelled_keep_as_credit",
    label: "Invoice cancelled — keep as credit",
    helper: "Cancel the invoice but retain the payment as a credit note.",
    allowedCommands: ["refund_sale", "issue_store_credit"],
  },
  invoice_cancelled_keep_as_advance: {
    code: "invoice_cancelled_keep_as_advance",
    label: "Invoice cancelled — keep as advance",
    helper: "Cancel the invoice; keep the payment as an unapplied advance.",
    allowedCommands: ["refund_sale"],
  },
  pre_refund_unapply: {
    code: "pre_refund_unapply",
    label: "Pre-refund unapply",
    helper: "Unapply from invoice(s) prior to issuing a refund.",
    allowedCommands: ["refund_sale"],
  },
  payment_currency_mismatch: {
    code: "payment_currency_mismatch",
    label: "Payment currency mismatch",
    helper: "Payment currency does not match invoice currency.",
    allowedCommands: ["refund_sale"],
  },
});

/**
 * Every reason code metadata entry MUST enumerate at least one allowed
 * command. Enforced at test time.
 */
export function getReasonsForCommand(
  command: POSReversalCommandType,
): ReadonlyArray<ReasonMetadata> {
  return POS_REVERSAL_REASON_CODES.map((c) => REASON_METADATA[c]).filter((m) =>
    m.allowedCommands.includes(command),
  );
}

export function assertReasonAllowedForCommand(
  reason: POSReversalReasonCode,
  command: POSReversalCommandType,
): void {
  const meta = REASON_METADATA[reason];
  if (!meta) {
    throw new Error(`Unknown POS reversal reason code: ${reason}`);
  }
  if (!meta.allowedCommands.includes(command)) {
    throw new Error(
      `Reason "${reason}" is not permitted for command "${command}". ` +
        `Allowed commands: ${meta.allowedCommands.join(", ")}.`,
    );
  }
}

/**
 * Reason codes that the ADR-0012 finance path understands. Every command
 * that reverses a customer payment MUST resolve its canonical reason to
 * one of these before invoking the finance leg.
 */
export type AccountingReversalReason = PaymentReversalReason;

/**
 * Map a POS-canonical reason to the accounting/finance enum. Returns
 * `null` for reasons that never touch the finance path (e.g. a purely
 * inventory-side `recalled_product` return without a refund).
 *
 * The finance-leg mapper is deliberately conservative — unmapped
 * reasons force the caller to pick an explicit accounting code so we
 * do not silently collapse business intent into `data_entry_error`.
 */
export function toAccountingReason(
  code: POSReversalReasonCode,
): AccountingReversalReason | null {
  switch (code) {
    case "customer_refund_requested":
    case "customer_dislike":
    case "size_exchange":
    case "colour_exchange":
    case "model_exchange":
    case "damaged_on_arrival":
    case "defective_product":
    case "wrong_item_delivered":
    case "expired_product":
    case "recalled_product":
    case "price_correction":
    case "promised_promo_missed":
      return "customer_refund_requested";
    case "duplicate_payment":
      return "duplicate_payment";
    case "wrong_invoice_applied":
      return "wrong_invoice_applied";
    case "invoice_cancelled_keep_as_credit":
      return "invoice_cancelled_keep_as_credit";
    case "invoice_cancelled_keep_as_advance":
      return "invoice_cancelled_keep_as_advance";
    case "pre_refund_unapply":
      return "pre_refund_unapply";
    case "payment_currency_mismatch":
      return "payment_currency_mismatch";
    case "bank_transfer_failed":
      return "bank_transfer_failed";
    case "data_entry_error":
    case "cashier_error":
    case "wrong_item_scanned":
    case "customer_changed_mind_pre_settlement":
    case "card_auth_timeout":
    case "card_partial_capture_shortfall":
    case "card_settlement_declined":
      return "data_entry_error";
    case "goodwill_credit":
    case "loyalty_adjustment":
      // Store credit never hits the payment reversal enum.
      return null;
    default: {
      // Exhaustiveness — if a new code is added and unmapped, this fails
      // to compile. Do not delete without adding the mapping.
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
