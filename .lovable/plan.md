# Product GL Account Inheritance — continuation status

Ladder (ADR 0122, `docs/adr/0122-product-gl-account-inheritance-ladder.md`):

```text
line override  ->  product  ->  product category (nearest ancestor)  ->  company default
```

Bill expense adds a vendor tier between category and company default.

## P0 — COMPLETE, verified

- `_account_is_postable(org, business, account)` — company-scoped + active check.
- `resolve_product_account_override(org, business, product, purpose)` — product
  then nearest ancestor category, **no** company default. For callers whose
  final tier differs (e.g. the vendor's own expense account).
- `resolve_product_gl_account` = override tiers + company default, so the chain
  has exactly one implementation. `STABLE SECURITY DEFINER`, `authenticated` +
  `service_role` only.
- `resolve_delivery_cogs_lines` + `complete_delivery_atomic` — per-line COGS and
  inventory through the ladder (was hardcoded to `detail_type`).
- `generate_recurring_invoice_occurrence` — revenue through the ladder.
- `confirm_bill_atomic` — inventory and purchase/expense resolve
  product -> category -> vendor default -> company default.

Re-verified this session via `pg_get_functiondef`: delivery delegates through
`resolve_delivery_cogs_lines`, recurring invoices call
`resolve_product_gl_account`, `confirm_bill_atomic` calls
`resolve_product_account_override`.

## P1 — COMPLETE, verified (this session)

Migration `20260808183816` — stock adjustments and opening stock onto the ladder:

- `approve_stock_adjustment_atomic` — the inventory side is now resolved **per
  line** (`resolve_product_account_override(... 'inventory')` -> company
  inventory account). The offset accumulator is keyed on
  `(inv_account_id, offset_account_id)`, and the journal emits one inventory
  line per resolved account plus the offset lines aggregated per offset
  account. Previously every line was forced onto the single company inventory
  account, so a product or category override was silently discarded.
- `record_opening_stock` — opening inventory debits are accumulated per
  resolved inventory account; the opening-equity credit stays a single line for
  the total, so the entry still balances.
- `post_stock_adjustment_gl` (`opening` / `revaluation`) — per-line valuation
  bucketed by resolved inventory account; counter account (Opening Balance
  Equity / Inventory Adjustment) unchanged and still a single line.

Safety: the migration opens with a match-or-raise guard on the audited source
of each function, so drift aborts instead of silently overwriting. No schema,
grant, RLS or policy change; lot/FEFO handling, cost resolution, period locks
and idempotency paths are byte-identical to the audited source.

Guard test added: `src/test/architecture/inventory-adjustment-account-ladder.test.ts`
— asserts all three functions call `resolve_product_account_override`, never
resolve accounts by `detail_type`, and still post through
`post_journal_entry_atomic`.

Also repaired an orphaned guard: `opening-stock-gl-trigger.test.ts` still read
`src/pages/Products.tsx`, but the create-with-opening-stock flow now lives in
`src/pages/inventory/ProductForm.tsx`. It was failing before this session's
changes; it now guards the real call site.

Verification: 7/7 guard tests green, `tsgo --noEmit` clean.

## Active phase

P1 is closed. **Next: P1 item 2 — POS statement posting.**

## Remaining

1. **P1 (next)** — POS statement posting still inlines
   `COALESCE(product.x, default)`; bring `process_pos_transaction` /
   `process_pos_return` / the POS statement posting function onto the ladder
   (revenue, COGS, inventory), grouping JE lines per resolved account exactly
   as P1 did for adjustments.
2. **P2** — purchases-side UI parity: bill and PO line account overrides should
   show the same inheritance badges as the product form
   (`ProductAccountSelector`).
3. **P3** — architecture guard that greps `pg_get_functiondef` for posting
   functions reading `products.sales_account_id` / `cogs_account_id` /
   `inventory_account_id` directly, or resolving accounts by `detail_type`.

## Instructions for the next agent

1. **Verify before continuing.** Confirm P1 actually holds in the live DB:

   ```sql
   SELECT p.proname,
          position('resolve_product_account_override' in pg_get_functiondef(p.oid)) > 0 AS delegates
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('approve_stock_adjustment_atomic',
                        'record_opening_stock',
                        'post_stock_adjustment_gl');
   ```

   All three must be `true`. Also re-check the P0 set (delivery, recurring
   invoice, bill) the same way, and run the guard suites plus `tsgo --noEmit`.
   If any adjustment posts an unbalanced journal, the per-account grouping in
   `approve_stock_adjustment_atomic` is the place to look.
2. Then resume at Remaining item 1 (POS). Do not start unrelated work, and do
   not leave a posting path half-migrated — each function must be coherent and
   balanced before moving on.
3. Keep `src/lib/resolveProductAccounts.ts` tier-identical with the SQL; the
   ladder guard test exists to catch drift.
