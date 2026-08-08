# Product GL Account Inheritance — Verification Report & Continuation Plan

## Phase 1 verification of the previous engineer's claims

I verified every claim against the live database and the codebase. Results:

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 1 — `ProductAccountSelector` shows the effective account, no bare "Use system default" | **CONFIRMED** | The literal string survives only in the guard test and an unrelated POS component; the selector, product form, Accounting tab and contact defaults all exist |
| Phase 2 — four account columns on `product_categories` | **CONFIRMED** | `sales_account_id`, `purchase_account_id`, `cogs_account_id`, `inventory_account_id`, all nullable |
| Phase 2 — cycle-safe ancestor walk + category editor + `confirmInvoiceGL` | **CONFIRMED** | `src/lib/productCategoryAccounts.ts`, `ProductCategoriesManager`, `src/hooks/invoices/confirmInvoiceGL.ts` |
| Phase 3 — `resolve_product_gl_account` exists, STABLE SECURITY DEFINER, rejects unknown purpose | **CONFIRMED** | Function body implements product -> recursive category chain (depth-bounded 20) -> `default_account_settings` |
| Phase 3 — `_resolve_invoice_gl_accounts` delegates to it | **CONFIRMED** | It no longer references any `products.*_account_id` column |
| Guard test green | **CONFIRMED** | 8/8 pass |
| "Remaining paths are delivery COGS (`complete_delivery_atomic`), bill/expense, POS" | **WRONG / INCOMPLETE** | See below |

### The pending-work list was materially wrong

`complete_delivery_atomic` does **not** read product account columns at all. It
resolves both accounts with a bare `SELECT id ... FROM public.accounts` lookup —
by account code/type, not through `default_account_settings` and not through the
ladder. So the product's COGS and Inventory overrides are **silently ignored on
every delivery**. That is not "the ladder minus the category tier" as the plan
claimed; it is a different, fourth resolution mechanism.

The audit also surfaced posting paths the previous plan never listed:

- `generate_recurring_invoice_occurrence` — inline `COALESCE(p.sales_account_id,
  v_rev_default)`. A recurring invoice therefore posts revenue differently from a
  manual invoice for the same product, which now goes through the ladder.
- `approve_stock_adjustment_atomic`, `backfill_missing_adjustment_je`,
  `ensure_inventory_gl_accounts` — resolve inventory/COGS at org or company level
  only; the product's own inventory account is never consulted.
- `record_opening_stock` — uses a *third* default resolver,
  `resolve_default_account(business_id, 'inventory')`, rather than
  `get_default_account_id(org, business, key)`.
- `confirm_bill_atomic` — inline `COALESCE(p.inventory_account_id, v_default_inv)`
  and `p.purchase_account_id -> contact.default_expense_account_id -> v_default_exp`.
  This one genuinely is the ladder minus the category tier.

### Two further defects found in the canonical resolver itself

1. **No company scoping on tiers 1 and 2.** The product and category tiers return
   an account id without checking it belongs to `p_business_id`. Only the company
   default tier is business-scoped. In a multi-company org a shared category can
   hand back another company's account.
2. **No `is_active` check.** An archived account already set on a product or
   category is still returned and posted.

### Verdict on the original question

The reported "Use system default" issue was **C — architecturally incomplete**,
not merely cosmetic. Phase 1/2 fixed the visible half honestly. The half that
matters for correctness is still open: the UI now promises an effective account
that three of the four accounts do not actually honour at posting time. Historical
integrity is sound (postings persist the resolved account id, delivery persists
`cost_at_shipment`), so this is a forward-correctness problem, not a corruption one.

## Continuation plan

### P0 — Accounting correctness

1. `complete_delivery_atomic`: replace both code/type `SELECT ... FROM accounts`
   lookups with `resolve_product_gl_account(..., 'cogs')` and `(..., 'inventory')`
   resolved **per line item**, falling back to the existing behaviour only when the
   ladder returns NULL. Delivery is currently the single largest divergence.
2. `generate_recurring_invoice_occurrence`: delegate revenue to the resolver so
   recurring and manual invoices agree.
3. `confirm_bill_atomic`: delegate to `purchase_expense` / `inventory`, preserving
   the vendor-level `default_expense_account_id` tier by inserting it between the
   category tier and the company default.
4. Harden `resolve_product_gl_account`: reject accounts whose `business_id` differs
   from `p_business_id`, and skip `is_active = false` accounts, continuing down the
   ladder instead of returning them.

### P1 — Domain architecture

5. Bring the stock-adjustment and opening-stock family onto the ladder:
   `approve_stock_adjustment_atomic`, `record_opening_stock`,
   `backfill_missing_adjustment_je`, `ensure_inventory_gl_accounts`.
6. Retire `resolve_default_account` in favour of `get_default_account_id` so one
   default resolver remains.

### P2 — User experience

7. Purchases-side parity: bill and PO line account overrides get the same
   inheritance badges as the product form.
8. Category editor: warn when a category account belongs to a different company.

### P3 — Hardening

9. Architecture test over `pg_get_functiondef` asserting no posting function reads
   `products.*_account_id` or selects accounts by code/type. This test is what
   would have caught the previous engineer's incorrect status claims.
10. Keep `src/lib/resolveProductAccounts.ts` tier-identical to the SQL function;
    extend the existing guard test to cover the new company-scope and is-active rules.
11. Update ADR 0122 — its "Consequences" section currently states the remaining
    paths are the ladder minus the category tier, which the audit disproves.

## Technical notes

Each SQL change is a migration replacing the function body; no schema change is
required except optional indexes. Historical journal entries are untouched
throughout — every path already persists resolved account ids.
