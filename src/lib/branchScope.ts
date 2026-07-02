/**
 * Branch-scoping helper for Supabase queries.
 *
 * Sales reads (invoices, sales orders, deliveries, estimates, credit notes,
 * sales returns, payments, customer statements) MUST be filtered by the
 * active branch when one is selected. RLS only enforces company-level
 * isolation — branch isolation is an application-layer concern.
 *
 * Convention (Odoo-aligned, matches `branchScoped.ts` for settings rows):
 *   - No active branch (HQ context) → no branch filter, return everything
 *     for the company (legacy/HQ-owned + all branch rows).
 *   - Active branch X → return rows scoped to branch X PLUS legacy
 *     company-shared rows (branch_id IS NULL). This avoids hiding pre-
 *     branch data while still excluding sibling branches' data.
 *
 * Branch id MUST be included in the React Query `queryKey` so cached
 * data is correctly partitioned per branch context.
 *
 * Usage:
 *   // SCOPE-EXEMPT: JSDoc example, not executed code
 *   let q = supabase.from('invoices').select(...).eq('organization_id', orgId);
 *   q = applyBranchFilter(q, currentBranch?.id ?? null);
 */

// Use a permissive generic so this works with both PostgrestFilterBuilder
// and PostgrestTransformBuilder regardless of select projection types.
export function applyBranchFilter<Q extends { or: (filter: string) => Q }>(
  query: Q,
  branchId: string | null | undefined,
  column = "branch_id",
): Q {
  if (!branchId) return query;
  // Match either rows scoped to this branch OR legacy/company-shared rows
  // (branch_id IS NULL). PostgREST `.or()` accepts the standard syntax.
  return query.or(`${column}.eq.${branchId},${column}.is.null`);
}
