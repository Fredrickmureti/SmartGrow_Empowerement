/**
 * useFinanceScope — single source of truth for branch/business scope in
 * the Finance module.
 *
 * Accounting model (Odoo / QuickBooks aligned):
 *   - Organization = tenant. Business = legal accounting entity (own books,
 *     COA, taxes, fiscal periods, mappings, lock dates).
 *   - Branch = operational location inside a business. Branches share the
 *     parent business COA and finance settings. Branches MAY own their own
 *     transactional records (invoices, bills, payments, JEs, bank accounts,
 *     budgets, fixed assets).
 *
 * Visibility rules enforced everywhere in Finance:
 *   - currentBranch != null  → scope is THAT branch (rows where
 *     branch_id = currentBranch.id OR branch_id IS NULL).
 *   - currentBranch == null  → consolidated view across all branches of
 *     the active business. Treated as the "All Branches / HQ aggregate"
 *     mode. Pages and reports MUST display the scope label so the user
 *     knows whether they are looking at a single branch or the aggregate.
 *
 * Every Finance query/RPC/cache key MUST consume the values returned here
 * so that branch switches automatically invalidate data and no page
 * silently mixes HQ and branch numbers.
 */
import { useMemo } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export interface FinanceScope {
  /** Current organization (tenant) id, or empty string when not loaded. */
  orgId: string;
  /** Current business (legal entity) id, or null when none selected. */
  businessId: string | null;
  /** Current branch id, or null when "All branches / HQ aggregate" mode. */
  branchId: string | null;
  /**
   * Branch id to pass into RPCs/queries. Same as `branchId` — kept as a
   * separate property so callers explicitly opt-in to the branch filter.
   */
  rpcBranchId: string | null;
  /** True when no branch is selected and the user is viewing aggregate. */
  isConsolidated: boolean;
  /** True when the active business has more than one branch. */
  hasMultipleBranches: boolean;
  /**
   * True when the active branch is the headquarters branch. HQ is the
   * canonical edit context for business-level finance config (COA, fiscal
   * periods, finance settings, tax mappings) — Odoo / QuickBooks aligned.
   */
  isHeadquartersContext: boolean;
  /**
   * True when the user is operating inside a NON-HQ branch of a
   * multi-branch business. Business-level finance pages must render in
   * read-only mode in this state. HQ branch and single-branch businesses
   * always evaluate to false.
   */
  isBranchScopedReadOnly: boolean;
  /**
   * Human-readable scope label, e.g. "Acme Ltd · Nairobi Branch" or
   * "Acme Ltd · All Branches (Consolidated)". Use in page headers and
   * report PDFs so the active scope is never ambiguous.
   */
  scopeLabel: string;
  /** True when org + business are both selected (queries can run). */
  isReady: boolean;
}

export function useFinanceScope(): FinanceScope {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch, hasMultipleBranches } = useBranch();

  return useMemo<FinanceScope>(() => {
    const orgId = currentOrg?.id ?? "";
    const businessId = currentBusiness?.id ?? null;
    const branchId = currentBranch?.id ?? null;
    const isConsolidated = branchId === null;

    const businessLabel = currentBusiness?.name ?? "Business";
    const branchLabel = isConsolidated
      ? hasMultipleBranches
        ? "All Branches (Consolidated)"
        : "All Branches"
      : currentBranch?.is_headquarters
        ? `${currentBranch.name} (HQ)`
        : currentBranch?.name ?? "Branch";

    const isHeadquartersContext = !!currentBranch?.is_headquarters;
    const isBranchScopedReadOnly =
      hasMultipleBranches && !isConsolidated && !isHeadquartersContext;

    return {
      orgId,
      businessId,
      branchId,
      rpcBranchId: branchId,
      isConsolidated,
      hasMultipleBranches,
      isHeadquartersContext,
      isBranchScopedReadOnly,
      scopeLabel: `${businessLabel} · ${branchLabel}`,
      isReady: !!orgId && !!businessId,
    };
  }, [currentOrg?.id, currentBusiness?.id, currentBusiness?.name, currentBranch, hasMultipleBranches]);
}
