/**
 * Resolves GL accounts for a product using the 4-tier priority (ADR 0122):
 * 1. Line-level override (passed in)
 * 2. Product default (from product record)
 * 3. Product category default (walking parent_id upward)
 * 4. System default (from useDefaultAccounts)
 */

import type { DefaultAccountMappings } from "@/hooks/useDefaultAccounts";
import {
  resolveCategoryAccount,
  type CategoryAccountField,
  type CategoryAccountNode,
} from "@/lib/productCategoryAccounts";

export type { CategoryAccountNode };

export interface ProductAccountInfo {
  category_id?: string | null;
  sales_account_id?: string | null;
  purchase_account_id?: string | null;
  cogs_account_id?: string | null;
  inventory_account_id?: string | null;
  cost_price?: number | null;
  track_inventory?: boolean;
}

export interface ResolvedLineAccounts {
  revenueAccountId: string;
  cogsAccountId: string | null;
  inventoryAccountId: string | null;
}

/**
 * Resolves the GL accounts for a single invoice/sale line item.
 * 
 * @param product - Product with optional account mappings (null for free-text lines)
 * @param systemDefaults - System-level default account mappings
 * @param lineOverrides - Optional line-level account overrides
 */
export function resolveLineAccounts(
  product: ProductAccountInfo | null | undefined,
  systemDefaults: DefaultAccountMappings,
  lineOverrides?: { revenue_account_id?: string; cogs_account_id?: string; inventory_account_id?: string },
  categories?: CategoryAccountNode[]
): ResolvedLineAccounts {
  const fromCategory = (field: CategoryAccountField): string | null =>
    categories?.length
      ? resolveCategoryAccount(categories, product?.category_id, field).accountId
      : null;

  // Revenue: line override > product default > category default > system default
  const revenueAccountId =
    lineOverrides?.revenue_account_id ||
    product?.sales_account_id ||
    fromCategory("sales_account_id") ||
    systemDefaults.sales_revenue_id ||
    "";

  // COGS: only relevant for inventory products
  let cogsAccountId: string | null = null;
  let inventoryAccountId: string | null = null;

  if (product?.track_inventory && product?.cost_price && product.cost_price > 0) {
    cogsAccountId =
      lineOverrides?.cogs_account_id ||
      product?.cogs_account_id ||
      fromCategory("cogs_account_id") ||
      systemDefaults.cost_of_goods_sold_id ||
      null;

    inventoryAccountId =
      lineOverrides?.inventory_account_id ||
      product?.inventory_account_id ||
      fromCategory("inventory_account_id") ||
      systemDefaults.inventory_account_id ||
      null;
  }

  return { revenueAccountId, cogsAccountId, inventoryAccountId };
}

/**
 * Resolved accounts for a single bill/purchase line item.
 */
export interface ResolvedBillLineAccounts {
  expenseAccountId: string;
  inventoryAccountId: string | null;
}

/**
 * Resolves the GL accounts for a single bill line item.
 * Priority: line override → product.purchase_account_id → category → vendor default → system default
 *
 * For inventory-tracked products, debits the Inventory asset account instead of expense.
 */
export function resolveBillLineAccounts(
  product: ProductAccountInfo | null | undefined,
  systemDefaults: DefaultAccountMappings,
  lineOverrides?: { account_id?: string | null },
  vendorDefaults?: { default_expense_account_id?: string | null },
  categories?: CategoryAccountNode[]
): ResolvedBillLineAccounts {
  const fromCategory = (field: CategoryAccountField): string | null =>
    categories?.length
      ? resolveCategoryAccount(categories, product?.category_id, field).accountId
      : null;

  // Inventory-tracked products debit the inventory asset account
  if (product?.track_inventory) {
    const inventoryAccountId =
      lineOverrides?.account_id ||
      product?.inventory_account_id ||
      fromCategory("inventory_account_id") ||
      systemDefaults.inventory_account_id ||
      null;

    return {
      expenseAccountId: inventoryAccountId || systemDefaults.operating_expenses_id || "",
      inventoryAccountId,
    };
  }

  // Non-inventory: resolve expense account with 4-tier priority
  const expenseAccountId =
    lineOverrides?.account_id ||
    product?.purchase_account_id ||
    fromCategory("purchase_account_id") ||
    vendorDefaults?.default_expense_account_id ||
    systemDefaults.operating_expenses_id ||
    "";

  return { expenseAccountId, inventoryAccountId: null };
}

/**
 * Groups line items by resolved revenue account to minimize JE lines.
 * Returns a map of accountId → total amount.
 */
export function groupByAccount(
  lines: Array<{ accountId: string; amount: number }>
): Map<string, number> {
  const grouped = new Map<string, number>();
  for (const line of lines) {
    grouped.set(line.accountId, (grouped.get(line.accountId) || 0) + line.amount);
  }
  return grouped;
}
