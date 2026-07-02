/**
 * withScope — propagate dashboard scope to drill-down URLs.
 *
 * Dashboard cards link into module pages (invoices, inventory, finance
 * reports, bills, banking). Without scope propagation, clicking
 * "Receivables" from the All-Branches consolidated view would land in
 * /sales/invoices showing only the user's currently-selected branch —
 * silently narrowing the dataset and confusing the user.
 *
 * Receiving pages should read `scope` and `branchId` from the URL on
 * first mount and prefer them over BranchContext for that view, falling
 * back to context when absent.
 */
export type DashboardScopeKind = "branch_only" | "all_branches" | "business_only";

export interface DashboardScope {
  kind: DashboardScopeKind;
  businessId: string | null;
  branchId: string | null;
}

export function withScope(path: string, scope: DashboardScope | null | undefined): string {
  if (!scope || !scope.businessId) return path;

  const url = new URL(path, "https://placeholder.local");
  url.searchParams.set("scope", scope.kind);
  url.searchParams.set("businessId", scope.businessId);
  if (scope.kind === "branch_only" && scope.branchId) {
    url.searchParams.set("branchId", scope.branchId);
  }
  // Preserve original path semantics — strip the placeholder origin.
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Read a scope object from a URLSearchParams. Returns null when no
 * `scope` param is present so callers can fall back to context.
 */
export function readScopeFromSearch(search: URLSearchParams): DashboardScope | null {
  const kind = search.get("scope") as DashboardScopeKind | null;
  if (!kind || (kind !== "branch_only" && kind !== "all_branches" && kind !== "business_only")) {
    return null;
  }
  return {
    kind,
    businessId: search.get("businessId"),
    branchId: search.get("branchId"),
  };
}