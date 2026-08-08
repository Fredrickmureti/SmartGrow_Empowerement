# Product GL Account Inheritance — Project Plan

Authoritative status for the product / category / company GL account ladder
(ADR 0122: `docs/adr/0122-product-gl-account-inheritance-ladder.md`).

## Ladder

```text
line override  ->  product  ->  product category (nearest ancestor)  ->  company default
```

## Phase 1 — Make the effective account visible (COMPLETE, verified)

- `ProductAccountSelector` shows the resolved account (`4000 — Sales Revenue`)
  with a `Default` / `From category "X"` / `Override` badge, a reset action,
  and an amber "no default mapped" warning linking to Finance → Settings.
- Applied to the product form, the product detail Accounting tab, and contact
  AR/AP/expense defaults.
- Verified: typecheck clean; guard test asserts the opaque
  "Use system default" copy can never return.

## Phase 2 — Category tier (COMPLETE, verified)

- Migration added `sales_account_id`, `purchase_account_id`, `cogs_account_id`,
  `inventory_account_id` to `public.product_categories` (nullable = inherit).
- `src/lib/productCategoryAccounts.ts`: cycle-safe ancestor walk.
- `src/lib/resolveProductAccounts.ts`: category tier inserted for sales and
  purchase resolution.
- `ProductCategoriesManager`: category editor now sets the four accounts and
  shows what the parent chain would supply.
- `ProductForm`: selectors receive the live category tier as the product's
  category changes.
- `confirmInvoiceGL`: loads categories and passes them to `resolveLineAccounts`,
  so client-built invoice JEs honour the category tier.
- Verified: typecheck clean; 8/8 ladder guard tests pass.

## Phase 3 — Single canonical resolver (ACTIVE — server seam landed)

Done:
- `public.resolve_product_gl_account(org, business, product_id, purpose)` —
  `STABLE SECURITY DEFINER`, purposes `sales_revenue | purchase_expense | cogs |
  inventory`, unknown purpose raises, granted to `authenticated` + `service_role`.
- `_resolve_invoice_gl_accounts` delegates per-product revenue to it.
- ADR 0122 written; `src/test/architecture/product-gl-account-ladder.test.ts`
  pins tier precedence and the UI copy rule.

Pending (next milestone, in this order):
1. Migrate remaining SQL posting paths off inline `COALESCE(product.x, default)`
   onto `resolve_product_gl_account`: delivery COGS/inventory
   (`complete_delivery_atomic`), bill/expense posting, POS statement posting.
   Each is safe: inline form == ladder minus the category tier.
2. Add a pgTAP-style SQL assertion (or an architecture test that greps
   `pg_get_functiondef`) proving no posting function reads
   `products.sales_account_id` / `cogs_account_id` / `inventory_account_id`
   directly.
3. Purchases-side UI parity: bill and PO line account overrides should show the
   same inheritance badges as the product form.

## Instructions for the next agent

1. Verify before continuing. Confirm, do not assume:
   - `resolve_product_gl_account` exists and returns the product tier, then the
     nearest ancestor category, then the company default (test with real ids).
   - `product_categories` has the four account columns and the category editor
     persists them.
   - `bunx vitest run src/test/architecture/product-gl-account-ladder.test.ts`
     is green and typecheck is clean.
2. Then resume at Phase 3 pending item 1 — do not start unrelated work.
3. Keep the client mirror (`src/lib/resolveProductAccounts.ts`) and the SQL
   function tier-identical; the guard test exists to catch drift.
