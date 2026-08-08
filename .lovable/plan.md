# Product GL Account Inheritance — continuation status

Ladder (ADR 0122, `docs/adr/0122-product-gl-account-inheritance-ladder.md`):

```text
line override  ->  product  ->  product category (nearest ancestor)  ->  company default
```

Bill expense adds a vendor tier between category and company default.

## P0 — COMPLETE, verified this session

- `_account_is_postable(org, business, account)` — company-scoped + active check.
- `resolve_product_account_override(org, business, product, purpose)` — product
  then nearest ancestor category, **no** company default. For callers whose
  final tier differs (e.g. the vendor's own expense account).
- `resolve_product_gl_account` = override tiers + company default, so the chain
  has exactly one implementation. `STABLE SECURITY DEFINER`, `authenticated` +
  `service_role` only.
- `resolve_delivery_cogs_lines` + `complete_delivery_atomic` — delivery COGS and
  inventory now resolve per line through the ladder. Previously hardcoded to
  `detail_type = 'inventory' | 'cost_of_goods_sold'`, ignoring every override.
- `generate_recurring_invoice_occurrence` — revenue goes through the ladder.
  Previously `COALESCE(products.sales_account_id, default)`, so one product
  posted differently depending on manual vs scheduled invoicing.
- `confirm_bill_atomic` — inventory and purchase/expense resolve
  product -> category -> vendor default -> company default. The category tier
  was skipped entirely before.

Verified: guard tests 8/8 green, typecheck clean, every function patch applied
with a match-or-raise guard so source drift aborts instead of silently no-oping.

## Remaining

1. **P1** — stock adjustments and opening stock still resolve inventory/COGS by
   `detail_type`; bring them onto the ladder.
2. **P1** — POS statement posting still inlines `COALESCE(product.x, default)`.
3. **P2** — purchases-side UI parity: bill and PO line account overrides should
   show the same inheritance badges as the product form.
4. **P3** — architecture guard that greps `pg_get_functiondef` for posting
   functions reading `products.sales_account_id` / `cogs_account_id` /
   `inventory_account_id` directly, or resolving accounts by `detail_type`.

## Instructions for the next agent

1. Verify, don't assume: check the P0 functions still delegate, via
   `position('resolve_product_account_override' in pg_get_functiondef(oid)) > 0`.
2. Resume at remaining item 1. Do not start unrelated work.
3. Keep `src/lib/resolveProductAccounts.ts` tier-identical with the SQL; the
   guard test exists to catch drift.
