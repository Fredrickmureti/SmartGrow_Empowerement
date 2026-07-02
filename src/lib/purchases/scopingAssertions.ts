/**
 * Purchases scoping assertions — dev-only contamination guard.
 *
 * Verifies that every row returned from a purchases query belongs to the
 * currently active company (and, when a branch is active, the active branch).
 *
 * Runs ONLY in dev (`import.meta.env.DEV`). In production it is a no-op so
 * there is zero performance cost.
 *
 * Why this exists: RLS only enforces company-level isolation at the DB
 * level. Branch isolation and any application-side scoping bugs (a missed
 * `.eq("business_id", …)`) need to be caught at the boundary, not after
 * users complain that branch A is seeing branch B's bills.
 */

interface ScopedRow {
  business_id?: string | null;
  branch_id?: string | null;
}

export function assertCompanyScoped<T extends ScopedRow>(
  rows: T[] | null | undefined,
  expectedBusinessId: string,
  context: string,
): void {
  if (!import.meta.env.DEV) return;
  if (!rows?.length) return;
  const leaks = rows.filter(
    (r) => r.business_id != null && r.business_id !== expectedBusinessId,
  );
  if (leaks.length > 0) {
    // Loud but non-fatal — surfaces in console, never breaks user flow
    console.error(
      `[scoping] ${context}: ${leaks.length} row(s) leaked from another company`,
      { expected: expectedBusinessId, leaks },
    );
  }
}

export function assertBranchScoped<T extends ScopedRow>(
  rows: T[] | null | undefined,
  expectedBranchId: string | null,
  context: string,
): void {
  if (!import.meta.env.DEV) return;
  if (!rows?.length) return;
  if (!expectedBranchId) return; // HQ context — all branches visible
  const leaks = rows.filter(
    (r) => r.branch_id != null && r.branch_id !== expectedBranchId,
  );
  if (leaks.length > 0) {
    console.warn(
      `[scoping] ${context}: ${leaks.length} row(s) from a different branch`,
      { expected: expectedBranchId, leaks },
    );
  }
}
