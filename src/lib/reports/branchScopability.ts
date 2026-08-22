/**
 * Branch-scopability registry for finance reports — browser binding.
 *
 * The rule itself lives in
 * `supabase/functions/_shared/reports/branchScopability.ts` so that the
 * screens and the server-side report builders (`render-report`,
 * `process-scheduled-reports`) answer the same question the same way. This
 * file used to carry its own copy of the table; a scheduled Trial Balance
 * could then be branch-sliced even though the screen refuses to slice it.
 *
 * Render rules (consumed by <ReportBranchFilter />):
 *   - kind in BRANCH_SCOPABLE → render the dropdown.
 *   - kind not in BRANCH_SCOPABLE → render nothing AND force branchId=null.
 *
 * Adding a new report? Register it in the shared module; if you do not, the
 * filter defaults to "entity-only" (safe).
 */
export {
  BRANCH_SCOPABLE,
  isBranchScopable,
  scopeBranchForReport,
  toReportKind,
} from "../../../supabase/functions/_shared/reports/branchScopability";
export type { ReportKind } from "../../../supabase/functions/_shared/reports/branchScopability";

import type { ReportKind } from "../../../supabase/functions/_shared/reports/branchScopability";

/**
 * Human-readable rationale shown next to entity-only reports so users
 * understand WHY there is no branch toggle. Keeps the UI honest and
 * preempts the "is the toggle broken?" support ticket. Presentation copy —
 * intentionally browser-only.
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
