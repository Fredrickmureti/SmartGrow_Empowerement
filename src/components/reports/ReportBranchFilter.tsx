/**
 * ReportBranchFilter
 *
 * Lightweight selector that wires the active company's branches into
 * `ReportFilterContext.filters.branchId`. Drop into any report toolbar to
 * enable per-branch P&L, Trial Balance, Sales, AR/AP, and GL views.
 *
 * "All branches" (NULL) returns the company-wide, consolidated view.
 *
 * Wave 5: now context-aware. Pass the `reportKind` so the filter:
 *   - Renders the dropdown only for branch-sliceable reports (P&L, GL,
 *     Journal, AR/AP aging, Partner Ledger, Depreciation, Audit Trail,
 *     Budget vs Actual, Sales, Inventory).
 *   - Renders nothing for entity-only reports (Balance Sheet, Cash Flow,
 *     Trial Balance, Tax, Consolidation) AND clears any leftover branchId
 *     so the next render is a clean entity-level statement.
 *
 * The branch-scopability registry lives in
 * `src/lib/reports/branchScopability.ts`.
 */
import { useEffect } from "react";
import { useReportFilters } from "@/contexts/ReportFilterContext";
import { useBranch } from "@/contexts/BranchContext";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MapPin, Info } from "lucide-react";
import { isBranchScopable, entityOnlyReason, type ReportKind } from "@/lib/reports/branchScopability";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ALL_VALUE = "__all__";

interface ReportBranchFilterProps {
  /**
   * Kind of report this filter is being mounted on. Required so the
   * component can decide whether to render the dropdown or hide it.
   * If omitted, the filter behaves as branch-sliceable (legacy behavior)
   * for backward compatibility — but new callers should always pass it.
   */
  reportKind?: ReportKind;
}

export function ReportBranchFilter({ reportKind }: ReportBranchFilterProps = {}) {
  const { filters, setBranchId } = useReportFilters();
  const { branches, currentBranch } = useBranch();
  const { allowed: canConsolidate, isLoading } = useFinancePermission(
    "finance.view_consolidated",
  );

  const scopable = reportKind ? isBranchScopable(reportKind) : true;

  // Entity-only reports must not carry a branch filter. If a previous
  // report (in the same provider) set one, clear it on mount so the
  // next data fetch is the clean entity-level statement.
  useEffect(() => {
    if (!scopable && filters.branchId !== null) {
      setBranchId(null);
    }
  }, [scopable, filters.branchId, setBranchId]);

  // Default branch-restricted users to their own branch instead of
  // "All branches" — RLS would mask the data anyway, but we want the
  // UI to be honest about scope from the first paint.
  useEffect(() => {
    if (!scopable) return;
    if (isLoading) return;
    if (!canConsolidate && filters.branchId === null && currentBranch?.id) {
      setBranchId(currentBranch.id);
    }
  }, [scopable, isLoading, canConsolidate, filters.branchId, currentBranch?.id, setBranchId]);

  // Entity-only reports → render an inline rationale (no dropdown).
  if (!scopable) {
    const reason = reportKind ? entityOnlyReason(reportKind) : null;
    if (!reason) return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground cursor-help">
            <Info className="h-3.5 w-3.5" />
            Entity-level report
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-xs">{reason}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Hide the control entirely for single-branch companies.
  if (branches.length < 2) return null;

  return (
    <div className="flex items-center gap-2">
      <MapPin className="h-4 w-4 text-muted-foreground" />
      <Select
        value={filters.branchId ?? (canConsolidate ? ALL_VALUE : currentBranch?.id ?? ALL_VALUE)}
        onValueChange={(v) => setBranchId(v === ALL_VALUE ? null : v)}
      >
        <SelectTrigger className="h-8 w-[200px] text-xs">
          <SelectValue placeholder={canConsolidate ? "All branches" : "Select branch"} />
        </SelectTrigger>
        <SelectContent>
          {canConsolidate && (
            <SelectItem value={ALL_VALUE}>All branches (consolidated)</SelectItem>
          )}
          {branches.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
              {b.is_headquarters ? " · HQ" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
