/**
 * Category-level GL account inheritance.
 *
 * Phase 2 of the product GL ladder (ADR 0122): a product category may carry
 * its own revenue / purchase / COGS / inventory accounts, and a child category
 * inherits from the closest ancestor that defines one.
 *
 * Full ladder: line override → product → category (walking parent_id) → company default.
 */

export type CategoryAccountField =
  | "sales_account_id"
  | "purchase_account_id"
  | "cogs_account_id"
  | "inventory_account_id";

export interface CategoryAccountNode {
  id: string;
  name: string;
  parent_id: string | null;
  sales_account_id?: string | null;
  purchase_account_id?: string | null;
  cogs_account_id?: string | null;
  inventory_account_id?: string | null;
}

export interface CategoryAccountResolution {
  /** Account id defined on the category (or nearest ancestor), if any. */
  accountId: string | null;
  /** Name of the category that actually supplied the account. */
  categoryName: string | null;
}

/**
 * Walks from `categoryId` up the parent chain and returns the first category
 * that defines `field`. Cycle-safe.
 */
export function resolveCategoryAccount(
  categories: CategoryAccountNode[],
  categoryId: string | null | undefined,
  field: CategoryAccountField
): CategoryAccountResolution {
  if (!categoryId) return { accountId: null, categoryName: null };

  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let cursor: CategoryAccountNode | undefined = byId.get(categoryId);

  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const accountId = cursor[field];
    if (accountId) return { accountId, categoryName: cursor.name };
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }

  return { accountId: null, categoryName: null };
}
