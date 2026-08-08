/**
 * Estimate / quotation lifecycle — single source of truth for the client.
 *
 * The authoritative state machine lives in the database
 * (`set_estimate_status_atomic` + the `trg_estimate_status_write_guard`
 * trigger). This module mirrors it so the UI can render only legal
 * transitions; it must never be used to bypass the RPC.
 */

export type EstimateStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "rejected"
  | "expired"
  | "converted";

/** Mirror of the transition table in set_estimate_status_atomic(). */
export const ESTIMATE_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ["sent", "rejected", "expired"],
  sent: ["viewed", "accepted", "rejected", "expired"],
  viewed: ["accepted", "rejected", "expired"],
  accepted: ["converted", "rejected", "expired"],
  expired: ["sent"],
  rejected: [],
  converted: [],
};

export function canTransition(from: string, to: string): boolean {
  return (ESTIMATE_TRANSITIONS[from as EstimateStatus] ?? []).includes(to as EstimateStatus);
}

export function isTerminalEstimateStatus(status: string): boolean {
  return (ESTIMATE_TRANSITIONS[status as EstimateStatus] ?? []).length === 0;
}

export interface TotalsLine {
  line_total: number;
  tax_amount: number;
}
export interface TotalsCost {
  amount: number;
  tax_amount: number;
}

export interface EstimateTotals {
  /** Sum of item line totals (tax-exclusive), excluding additional costs. */
  subtotal: number;
  /** Item tax + additional-cost tax. */
  tax_amount: number;
  /** subtotal + additional costs + tax − discount. */
  total: number;
}

/**
 * The ONE totals formula for estimates. Create and edit must both use this —
 * previously the edit path silently dropped additional costs, which changed
 * the price of an estimate just by opening and saving it.
 */
export function computeEstimateTotals(
  items: TotalsLine[],
  additionalCosts: TotalsCost[] = [],
  discountAmount = 0,
): EstimateTotals {
  const subtotal = items.reduce((s, i) => s + (Number(i.line_total) || 0), 0);
  const itemsTax = items.reduce((s, i) => s + (Number(i.tax_amount) || 0), 0);
  const costsTotal = additionalCosts.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const costsTax = additionalCosts.reduce((s, c) => s + (Number(c.tax_amount) || 0), 0);
  const tax_amount = itemsTax + costsTax;
  return {
    subtotal,
    tax_amount,
    total: subtotal + costsTotal + tax_amount - (Number(discountAmount) || 0),
  };
}
