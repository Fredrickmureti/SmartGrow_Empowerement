/**
 * POS Reversal Eligibility — Stage 2 of the POS refund/reversal
 * remediation (see `.lovable/plan.md`).
 *
 * Pure functions that decide which commands are permissible against a
 * given transaction snapshot. No I/O, no toasts. The action menu in
 * the History screen consumes this to render only the commands that
 * make sense for the row it is drawing.
 *
 * Rules encoded here (from the audit):
 *   - Void is only valid on the same shift, before any goods movement.
 *   - Card auth reversal is only valid while the tender is authorized
 *     but not settled.
 *   - Refund is valid on any settled sale, subject to policy.
 *   - Return goods requires at least one returnable line item.
 *   - Exchange is refund+new-sale glue; needs a returnable line and
 *     a new sale to attach.
 *   - Store credit is valid on any settled sale with a known customer.
 */

import type { POSReversalCommandType } from "./reasonCodes";

/**
 * Minimal projection of a POS transaction needed for eligibility.
 * Callers may pass a fatter object; extra fields are ignored.
 */
export interface EligibilityFacts {
  /** Sale status; matches `pos_transactions.status`. */
  status:
    | "in_progress"
    | "held"
    | "completed"
    | "voided"
    | "refunded"
    | "exchanged"
    | "unknown";
  /** Whether the sale is still on the currently open shift. */
  isOnCurrentShift: boolean;
  /** Whether at least one tender has settled. */
  hasSettledTender: boolean;
  /** Whether at least one tender is authorized-but-not-settled. */
  hasAuthorizedCardTender: boolean;
  /** Whether goods physically left inventory. */
  goodsFulfilled: boolean;
  /** Number of return-eligible line items. */
  returnableLineCount: number;
  /** Whether the customer on the sale is a known contact (needed for store credit). */
  hasIdentifiedCustomer: boolean;
  /** Whether any refund/return has already been posted against the sale. */
  hasPriorReversal: boolean;
}

export interface EligibilityResult {
  command: POSReversalCommandType;
  eligible: boolean;
  /**
   * Machine-readable reason when `eligible` is false. Copy is resolved
   * upstream so ops can localise / rewrite without touching this file.
   */
  ineligibilityReason:
    | null
    | "sale_not_completed"
    | "sale_already_reversed"
    | "not_on_current_shift"
    | "goods_already_fulfilled"
    | "no_authorized_card_tender"
    | "no_settled_tender"
    | "no_returnable_lines"
    | "no_identified_customer";
}

const OK = (command: POSReversalCommandType): EligibilityResult => ({
  command,
  eligible: true,
  ineligibilityReason: null,
});
const NO = (
  command: POSReversalCommandType,
  ineligibilityReason: NonNullable<EligibilityResult["ineligibilityReason"]>,
): EligibilityResult => ({ command, eligible: false, ineligibilityReason });

export function evaluateEligibility(
  facts: EligibilityFacts,
): ReadonlyArray<EligibilityResult> {
  const results: EligibilityResult[] = [];

  // VoidSaleCommand
  if (facts.status === "voided" || facts.status === "refunded") {
    results.push(NO("void_sale", "sale_already_reversed"));
  } else if (facts.status !== "in_progress" && facts.status !== "held" && facts.status !== "completed") {
    results.push(NO("void_sale", "sale_not_completed"));
  } else if (!facts.isOnCurrentShift) {
    results.push(NO("void_sale", "not_on_current_shift"));
  } else if (facts.goodsFulfilled) {
    results.push(NO("void_sale", "goods_already_fulfilled"));
  } else {
    results.push(OK("void_sale"));
  }

  // ReverseCardAuthorizationCommand
  if (!facts.hasAuthorizedCardTender) {
    results.push(NO("reverse_card_authorization", "no_authorized_card_tender"));
  } else if (facts.status === "voided" || facts.status === "refunded") {
    results.push(NO("reverse_card_authorization", "sale_already_reversed"));
  } else {
    results.push(OK("reverse_card_authorization"));
  }

  // RefundSaleCommand
  if (facts.status !== "completed" && facts.status !== "exchanged") {
    results.push(NO("refund_sale", "sale_not_completed"));
  } else if (!facts.hasSettledTender) {
    results.push(NO("refund_sale", "no_settled_tender"));
  } else if (facts.status === "refunded" && !facts.returnableLineCount) {
    results.push(NO("refund_sale", "sale_already_reversed"));
  } else {
    results.push(OK("refund_sale"));
  }

  // ReturnGoodsCommand
  if (facts.status !== "completed" && facts.status !== "exchanged") {
    results.push(NO("return_goods", "sale_not_completed"));
  } else if (facts.returnableLineCount <= 0) {
    results.push(NO("return_goods", "no_returnable_lines"));
  } else {
    results.push(OK("return_goods"));
  }

  // ExchangeCommand
  if (facts.status !== "completed") {
    results.push(NO("exchange", "sale_not_completed"));
  } else if (facts.returnableLineCount <= 0) {
    results.push(NO("exchange", "no_returnable_lines"));
  } else {
    results.push(OK("exchange"));
  }

  // IssueStoreCreditCommand
  if (facts.status !== "completed" && facts.status !== "exchanged") {
    results.push(NO("issue_store_credit", "sale_not_completed"));
  } else if (!facts.hasIdentifiedCustomer) {
    results.push(NO("issue_store_credit", "no_identified_customer"));
  } else if (!facts.hasSettledTender) {
    results.push(NO("issue_store_credit", "no_settled_tender"));
  } else {
    results.push(OK("issue_store_credit"));
  }

  return results;
}

export function eligibleCommands(
  facts: EligibilityFacts,
): ReadonlyArray<POSReversalCommandType> {
  return evaluateEligibility(facts)
    .filter((r) => r.eligible)
    .map((r) => r.command);
}
