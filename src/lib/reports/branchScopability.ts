/**
 * Branch-scopability registry for finance reports.
 *
 * The branch / consolidated toggle is only meaningful for reports whose
 * underlying data is a *flow* or *dimensional slice* through the GL
 * (P&L, GL, Journal, Partner Ledger, AR/AP aging, etc.). It is NOT
 * meaningful for entity-level statements that describe the legal entity
 * as a whole: the Balance Sheet, Cash Flow Statement, Trial Balance,
 * Tax Reports, and Consolidation report all belong to the business and
 * cannot be split per branch without producing nonsense (assets,
 * liabilities, and equity belong to the legal entity, not a location).
 *
 * Render rules (consumed by <ReportBranchFilter />):
 *   - kind in BRANCH_SCOPABLE → render the dropdown.
 *   - kind not in BRANCH_SCOPABLE → render nothing AND force branchId=null.
 *
 * Adding a new report? Register it here; if you do not, the filter will
 * default to "entity-only" (safe).
 */

export type ReportKind =
  // Entity-only: presented for the legal entity, never sliced by branch
  | "balance_sheet"
  | "cash_flow"
  | "trial_balance"
  | "tax"
  | "consolidation"
  | "fx_revaluation"
  // Branch-sliceable: operational / dimensional reports
  | "pnl"
  | "general_ledger"
  | "journal"

  | "partner_ledger"
  | "ar_aging"
  | "ap_aging"
  | "budget_vs_actual"
  | "depreciation"
  | "audit_trail"
  | "sales"
  | "purchases"
  | "inventory"
  | "management"
  | "bank_reconciliation"
  
  | "stock_adjustment"
  | "stock_transfer";

export const BRANCH_SCOPABLE: Record<ReportKind, boolean> = {
  // Entity-only
  balance_sheet: false,
  cash_flow: false,
  trial_balance: false,
  tax: false,
  consolidation: false,
  fx_revaluation: false,

  // Branch-sliceable
  pnl: true,
  general_ledger: true,
  journal: true,
  partner_ledger: true,
  ar_aging: true,
  ap_aging: true,
  budget_vs_actual: true,
  depreciation: true,
  audit_trail: true,
  sales: true,
  purchases: true,
  inventory: true,
  management: true,
  bank_reconciliation: true,
  
  stock_adjustment: true,
  stock_transfer: true,
};

export function isBranchScopable(kind: ReportKind): boolean {
  return BRANCH_SCOPABLE[kind] === true;
}

/**
 * Human-readable rationale shown next to entity-only reports so users
 * understand WHY there is no branch toggle. Keeps the UI honest and
 * preempts the "is the toggle broken?" support ticket.
 */
export function entityOnlyReason(kind: ReportKind): string | null {
  switch (kind) {
    case "balance_sheet":
      return "Balance Sheet is presented for the legal entity. Assets, liabilities, and equity belong to the business as a whole and cannot be split by branch.";
    case "cash_flow":
      return "Cash Flow is presented for the legal entity. Cash positions are reconciled at the business level.";
    case "trial_balance":
      return "Trial Balance must balance at the legal entity level. A per-branch trial balance would not balance because intra-entity transfers and shared accounts (e.g. retained earnings) live at the business.";
    case "tax":
      return "Tax reports are filed by the legal entity, not by branch.";
    case "consolidation":
      return "Consolidation is by definition a business-level / multi-business view.";
    case "fx_revaluation":
      return "FX revaluation re-prices monetary assets and liabilities of the legal entity; gain/loss does not belong to a branch.";
    default:
      return null;
  }
}

