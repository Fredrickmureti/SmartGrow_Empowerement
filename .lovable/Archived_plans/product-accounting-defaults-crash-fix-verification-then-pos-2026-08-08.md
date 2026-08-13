# Product accounting defaults — crash fix, verification, then POS ladder

## P0 — Fix the add-product crash (confirmed root cause)

Switching Type on `/inventory-app/products/new` crashes with
`Cannot read properties of null (reading 'isServer')` from `useLinkProps`.

Cause (verified in code): `src/components/products/ProductAccountSelector.tsx`
line 22 imports `Link` from `@tanstack/react-router` and renders
`<Link to="/finance/settings">` in its "no default mapped" warning. That
component renders inside the legacy react-router-dom SPA (`src/App.tsx`,
mounted from the TanStack catch-all), where there is no TanStack router
context — so the router hook dereferences `null`. Changing Type to Product
reveals the inventory/COGS selectors, which is what triggers the render.

Fix the category, not just the one file. Three other components in the legacy
SPA tree import the same `Link` and will crash the same way:

- `src/components/products/ProductAccountSelector.tsx`
- `src/components/inventory/WarehouseScopeGate.tsx`
- `src/components/payroll/CompensationSetupDialog.tsx`
- `src/components/departments/DepartmentDetailSheet.tsx`

All four switch to `Link` from `react-router-dom` (the router that actually
owns these routes). Add an ESLint guard (`eslint-rules/`) forbidding
`@tanstack/react-router` imports outside `src/routes/`, `src/router.tsx` and
`src/main.tsx`, plus a source-level guard test, so this class of bug cannot
return.

Verification: load `/inventory-app/products/new` in a headless browser, switch
Type service -> product, confirm no error boundary and the four account
selectors render their effective account.

## P1 — Verify the previous engineer's claims before extending

Independently confirm, not assume:

1. In the live DB, `pg_get_functiondef` shows `resolve_product_gl_account` and
   `resolve_product_account_override` exist with the documented tiers, grants
   and `STABLE SECURITY DEFINER`.
2. The P0/P1 posting paths really delegate: delivery COGS
   (`resolve_delivery_cogs_lines`, `complete_delivery_atomic`),
   `generate_recurring_invoice_occurrence`, `confirm_bill_atomic`,
   `approve_stock_adjustment_atomic`, `record_opening_stock`,
   `post_stock_adjustment_gl`.
3. Journals from the rewritten adjustment/opening-stock functions balance when
   a product or category override splits inventory across accounts — check by
   summing debits/credits for a simulated multi-account case.
4. `src/lib/resolveProductAccounts.ts` is tier-identical with the SQL, and the
   existing guard tests actually assert that rather than passing vacuously.
5. Run the architecture guard suites and `tsgo --noEmit`.

Anything that fails moves back to pending and is fixed before new work.

## P2 — POS onto the ladder (next real feature work)

`process_pos_transaction`, `process_pos_return` and the POS statement posting
function still inline `COALESCE(product.x, default)`, so they silently ignore
the category tier. Migrate them to `resolve_product_account_override` +
company default for revenue, COGS and inventory, grouping journal lines per
resolved account exactly as the stock-adjustment work did. Returns must
reverse against the same resolved accounts as the original sale — resolve from
the original transaction lines, never re-resolve from current config.

## P3 — Purchases-side UI parity

Bill and PO line account overrides show the same inheritance badges
(`Inherited` / `From category "X"` / `Override`, amber when unmapped) as
`ProductAccountSelector`.

## P4 — Hardening

- Architecture guard grepping `pg_get_functiondef` for any posting function
  that reads `products.sales_account_id` / `cogs_account_id` /
  `inventory_account_id` directly, or resolves accounts by `detail_type`.
- SQL tests under `supabase/tests/` for the ladder, including archived/inactive
  account rejection and cycle-safe category walking.
- ADR 0122 updated once POS is migrated (it currently states POS is pending).

## Technical notes

- Historical safety is already structurally sound: postings persist the
  resolved `account_id` on journal lines, so a later default change affects
  future postings only. P1 item 3 confirms this holds for the rewritten paths.
- No schema, grant or RLS change is needed for P0; it is presentation-layer
  only.
