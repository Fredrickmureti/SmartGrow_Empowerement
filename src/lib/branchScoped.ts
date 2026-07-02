/**
 * Branch-scoped resolver — application-level twin of the SQL helper
 * `resolve_branch_scoped`.
 *
 * Convention (Odoo-aligned):
 *   - `branch_id IS NULL`       → record is shared across all branches of the company
 *   - `branch_id = <branch>`    → record is an override specific to that branch
 *
 * `pickEffective` returns the override if one exists, else the company-wide
 * record, else null. `tagScope` annotates a list with `__scope` for UI badges.
 */

export type BranchScope = "branch" | "company";

export interface BranchScoped {
  branch_id: string | null;
}

export interface ScopedRecord<T extends BranchScoped> {
  record: T;
  scope: BranchScope;
}

/**
 * From a list of records, pick the one that applies to the active branch.
 * Branch-specific override wins over company-wide shared.
 */
export function pickEffective<T extends BranchScoped>(
  records: T[],
  branchId: string | null,
): T | null {
  if (!records.length) return null;
  const override = branchId
    ? records.find((r) => r.branch_id === branchId)
    : null;
  if (override) return override;
  return records.find((r) => r.branch_id == null) ?? null;
}

/**
 * Tag every record in the list with its scope relative to the active branch.
 * Useful for rendering "This branch" vs "Company-wide" chips in settings UIs.
 */
export function tagScope<T extends BranchScoped>(
  records: T[],
  branchId: string | null,
): ScopedRecord<T>[] {
  return records.map((record) => ({
    record,
    scope: branchId && record.branch_id === branchId ? "branch" : "company",
  }));
}

/**
 * Filter records visible to the active branch — keeps overrides for THIS
 * branch + all company-wide rows; hides overrides scoped to OTHER branches.
 */
export function visibleForBranch<T extends BranchScoped>(
  records: T[],
  branchId: string | null,
): T[] {
  return records.filter(
    (r) => r.branch_id == null || (branchId != null && r.branch_id === branchId),
  );
}
