/**
 * ADR 0122 guard — product GL account inheritance ladder.
 *
 * Enforces that the client mirror of the ladder behaves exactly like the
 * canonical SQL resolver: line override -> product -> category (nearest
 * ancestor) -> company default. Regressions here silently misroute revenue,
 * COGS and inventory postings, so the checks are behavioural, not textual.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveCategoryAccount } from "@/lib/productCategoryAccounts";
import { resolveLineAccounts } from "@/lib/resolveProductAccounts";
import type { DefaultAccountMappings } from "@/hooks/useDefaultAccounts";

const categories = [
  { id: "root", name: "Goods", parent_id: null, sales_account_id: "acct-root" },
  { id: "mid", name: "Hardware", parent_id: "root" },
  { id: "leaf", name: "Laptops", parent_id: "mid" },
];

const defaults = {
  sales_revenue_id: "acct-company",
  cogs_id: "acct-cogs-company",
  inventory_account_id: "acct-inv-company",
} as unknown as DefaultAccountMappings;

describe("category account inheritance", () => {
  it("walks up to the nearest ancestor that defines the account", () => {
    const r = resolveCategoryAccount(categories, "leaf", "sales_account_id");
    expect(r.accountId).toBe("acct-root");
    expect(r.categoryName).toBe("Goods");
  });

  it("returns nothing when no ancestor defines the account", () => {
    expect(resolveCategoryAccount(categories, "leaf", "cogs_account_id").accountId).toBeNull();
  });

  it("is cycle safe", () => {
    const cyclic = [
      { id: "a", name: "A", parent_id: "b" },
      { id: "b", name: "B", parent_id: "a" },
    ];
    expect(resolveCategoryAccount(cyclic, "a", "sales_account_id").accountId).toBeNull();
  });
});

describe("four-tier ladder precedence", () => {
  const product = { category_id: "leaf", sales_account_id: "acct-product" };

  it("line override beats every other tier", () => {
    const r = resolveLineAccounts(product, defaults, { revenue_account_id: "acct-line" }, categories);
    expect(r.revenueAccountId).toBe("acct-line");
  });

  it("product beats category", () => {
    expect(resolveLineAccounts(product, defaults, undefined, categories).revenueAccountId).toBe("acct-product");
  });

  it("category beats company default", () => {
    const r = resolveLineAccounts({ category_id: "leaf" }, defaults, undefined, categories);
    expect(r.revenueAccountId).toBe("acct-root");
  });

  it("falls back to the company default", () => {
    expect(resolveLineAccounts({}, defaults, undefined, categories).revenueAccountId).toBe("acct-company");
  });
});

describe("selector never hides the effective account", () => {
  it("ProductAccountSelector has no bare 'Use system default' placeholder", () => {
    const src = readFileSync("src/components/products/ProductAccountSelector.tsx", "utf8");
    expect(src).not.toContain("Use system default");
  });
});
