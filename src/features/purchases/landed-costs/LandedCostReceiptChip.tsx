/**
 * LandedCostReceiptChip — the landed cost attached to one goods receipt,
 * rendered inline on procurement records.
 *
 * Reads the server-side rollup (`landed_cost_receipt_summary`); it never sums
 * allocations in the browser and never asserts a figure the ledger disagrees
 * with. Renders nothing when a receipt carries no landed cost.
 */
import { StatusBadge } from "@/design-system";

import type { LandedCostReceiptSummary } from "./useLandedCostReporting";

export function LandedCostReceiptChip({
  summary,
  formatCurrency,
}: {
  summary: LandedCostReceiptSummary | undefined;
  formatCurrency: (n: number) => string;
}) {
  if (!summary || summary.allocated_amount === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Landed cost</span>
      <span className="font-medium">{formatCurrency(summary.allocated_amount)}</span>
      {summary.posted_count > 0 && (
        <span className="text-muted-foreground">
          {formatCurrency(summary.capitalized_amount)} capitalised
          {summary.expensed_amount !== 0
            ? ` · ${formatCurrency(summary.expensed_amount)} to cost of sales`
            : ""}
        </span>
      )}
      {summary.pending_count > 0 && (
        <StatusBadge tone="warning">
          {summary.pending_count} not posted
        </StatusBadge>
      )}
    </div>
  );
}
