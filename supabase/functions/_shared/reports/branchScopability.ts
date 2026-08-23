/**
 * Branch-scopability registry — the ONE rule, shared by the screens and by
 * every server-side report builder.
 *
 * The branch / consolidated toggle is only meaningful for reports whose
 * underlying data is a *flow* or *dimensional slice* through the GL (P&L, GL,
 * Journal, Partner Ledger, AR/AP aging, …). It is NOT meaningful for
 * entity-level statements that describe the legal entity as a whole: Balance
 * Sheet, Cash Flow, Trial Balance, Tax and Consolidation belong to the
 * business and cannot be split per branch without producing nonsense (assets,
 * liabilities and equity belong to the legal entity, not a location; a
 * per-branch trial balance does not balance).
 *
 * Consumers:
 *   - `<ReportBranchFilter />` (via `src/lib/reports/branchScopability.ts`,
 *     which re-exports this module so the two can never drift) renders the
 *     dropdown only for scopable kinds and forces `branchId = null` otherwise.
 *   - `render-report` and `process-scheduled-reports` call
 *     `scopeBranchForReport` before dispatching to a builder, so a stored
 *     schedule or an API caller cannot obtain a branch-sliced balance sheet
 *     that the screen refuses to produce.
 *
 * Adding a new report? Register it here; unregistered kinds default to
 * entity-only (safe).
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
  | "budget_schedule"
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
  // A budget carries its OWN branch; the ambient branch must never
  // re-slice it, or a company-wide plan would print as a branch plan.
  budget_schedule: false,

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
 * Server-side report type identifiers differ slightly from the UI kinds
 * (`income_statement` / `profit_and_loss` vs `pnl`). Normalise here so the
 * single registry answers for both vocabularies.
 */
const SERVER_TYPE_ALIASES: Record<string, ReportKind> = {
  income_statement: "pnl",
  profit_and_loss: "pnl",
  profit_loss: "pnl",
  balance_sheet: "balance_sheet",
  trial_balance: "trial_balance",
  cash_flow: "cash_flow",
  general_ledger: "general_ledger",
  journal: "journal",
  journal_report: "journal",
  partner_ledger: "partner_ledger",
  ar_aging: "ar_aging",
  ap_aging: "ap_aging",
  budget_vs_actual: "budget_vs_actual",
  budget_schedule: "budget_schedule",
  depreciation: "depreciation",
  audit_trail: "audit_trail",
  bank_reconciliation: "bank_reconciliation",
  fx_revaluation: "fx_revaluation",
  consolidation: "consolidation",
};

export function toReportKind(reportType: string): ReportKind | null {
  if (SERVER_TYPE_ALIASES[reportType]) return SERVER_TYPE_ALIASES[reportType];
  return (reportType in BRANCH_SCOPABLE) ? (reportType as ReportKind) : null;
}

/**
 * The one gate every server dispatcher must pass a branch through. Returns
 * `undefined` for entity-level statements so the builder aggregates the whole
 * legal entity, exactly as the screen does.
 */
export function scopeBranchForReport(
  reportType: string,
  branchId?: string | null,
): string | undefined {
  if (!branchId) return undefined;
  const kind = toReportKind(reportType);
  if (!kind) return undefined; // unregistered → entity-only (safe)
  return isBranchScopable(kind) ? branchId : undefined;
}
