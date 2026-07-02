# Inventory account-role drift — root cause and fix

**Reported by:** `masindecare@gmail.com`, 2026-05-17
**Symptom:** Creating "Dell Laptop Latitude 5520" with opening qty 300 produced
"Product added successfully" followed immediately by
`Failed to create stock adjustment: Unknown account role "inventory_asset":
not registered in system_account_roles` (HTTP 400 from
`apply_or_request_stock_adjustment`). The product persisted; opening stock and
journal entry did not.
**Status:** ✅ Fixed via migration `_inventory_role_key_canonical` +
compensating-delete in `Products.tsx`.

---

## The three registries you have to understand

| Layer | Table / function | Vocabulary |
|---|---|---|
| **Canonical role registry** | `system_account_roles.role_key` | `inventory`, `inventory_adjustment`, `cogs`, … |
| **Per-tenant mapping** | `default_account_settings.setting_key` → `account_id` | Same canonical keys; gated by `validate_default_account_setting()` BEFORE-trigger that rejects unknown keys. |
| **Chart of accounts** | `accounts` (typed by `account_type` + `detail_type`) | Real GL accounts the mapping points at. |

The registry already encodes the account type via `required_account_type`, so a
parallel `_asset`-suffixed namespace is redundant — and dangerous, because the
validator only knows the canonical names.

## Root cause

Migration `20260517143924_*` ("Inventory GL auto-provisioning + readiness")
added `ensure_inventory_gl_accounts(org, biz)` to lazily provision the
Inventory and Inventory-Adjustment accounts for fresh tenants and persist the
mapping. The helper performed:

```sql
INSERT INTO default_account_settings (..., setting_key, ...)
VALUES (..., 'inventory_asset', v_inv)
ON CONFLICT ... DO UPDATE ...;
```

But the canonical key in `system_account_roles` is `'inventory'`, and
`canonicalize_role_key()` did not alias `inventory_asset → inventory`. The
validator trigger raised, the RPC rolled back, and because the UI orchestrated
product creation and the opening-stock RPC as **two separate client calls**,
the product was left orphaned.

A scan of `default_account_settings` shows every existing tenant already maps
`'inventory'` (never `'inventory_asset'`), confirming the registry was the
source of truth all along. The drift was isolated to the new helper, the
readiness view, and the absence of an alias.

## Fix

Migration: `_inventory_role_key_canonical`

1. Extend `canonicalize_role_key` with `'inventory_asset' → 'inventory'` so any
   legacy caller (admin scripts, third-party migrations, older UI builds)
   transparently lands on the canonical key.
2. Rewrite `ensure_inventory_gl_accounts` to read and UPSERT
   `setting_key='inventory'` and `'inventory_adjustment'`.
3. Rewrite `inventory_gl_readiness` to emit `'inventory'` so the Finance
   Settings UI shows the same key the validator expects.
4. Idempotent backfill: any stray `'inventory_asset'` row is upserted onto the
   canonical key (existing value wins on conflict) and deleted. No-op in
   production (zero rows today), but defensive for self-hosters.

Application: `src/pages/Products.tsx`

- Added a compensating `deleteProduct(created.id)` in the `catch` block of the
  opening-stock call. The product + opening-stock workflow is now atomic from
  the user's perspective: either both land or neither does. The toast text
  changes from "Product saved, but opening stock failed" to a single failure
  message that mentions the rollback.

Guards:

- `src/test/architecture/inventory-role-key-canonical.test.ts` — scans every
  migration for `'inventory_asset'` and fails unless the reference lives in
  the canonicalization-alias migration. Also asserts the alias migration
  contains the canonical alias branch and the canonical UPSERT.

## Opening-stock posting flow (post-fix)

```
Products.tsx ─ createProduct() ────► products
            └ createStockAdjustment() ─► apply_or_request_stock_adjustment
                                          │
                                          ├─► approval routing
                                          │
                                          └─► approve_stock_adjustment_atomic
                                                 │
                                                 ├─► stock_movements (+qty)
                                                 │
                                                 └─► ensure_inventory_gl_accounts
                                                       (resolves canonical
                                                        'inventory' +
                                                        'inventory_adjustment')
                                                       │
                                                       └─► journal_entries
                                                            Dr Inventory (1130)
                                                            Cr Inventory Adj (5100)
```

For negative adjustments (shrinkage) the signs are reversed.

## ERP comparison (sanity check on the model)

- **Odoo (Inventory + AVCO)** — continuous-valuation: opening qty hits the
  Stock Valuation account (asset) with the offset on the configured
  Stock Input / Stock Output account. Our `inventory` + `inventory_adjustment`
  pair is the same shape, with `inventory_adjustment` standing in for the
  bidirectional input/output offset (sufficient for the SMB scope today;
  splitting input vs output is tracked as a separate item, not part of this
  fix).
- **QuickBooks Online** — "Initial qty on hand" posts to Opening Balance
  Equity. We intentionally do not do this: it would change all existing
  tenants' equity reports retroactively, and the registered `inventory`
  account already carries the asset balance.
- **NetSuite** — item-level account mapping (Asset / COGS / Income). Our
  per-product `inventory_account_id`, `cogs_account_id`, `sales_account_id`
  override the system defaults exactly the same way (see
  `src/lib/resolveProductAccounts.ts`).

## Verification

- `select canonicalize_role_key('inventory_asset')` returns `'inventory'`.
- `select * from inventory_gl_readiness(<org>, <biz>)` returns
  `setting_key='inventory'`, `is_mapped=true` for an existing tenant.
- Manual repro: re-running the failing flow as `masindecare@gmail.com` now
  produces the product, the opening stock movement, and a balanced JE
  (Dr 1130 / Cr 5100).
- `select count(*) from default_account_settings where setting_key='inventory_asset'` → `0`.
- Architecture test green; no other migration references the legacy spelling.

## Out of scope (tracked, not done here)

- A single SECURITY DEFINER RPC `create_product_with_opening_stock` that
  wraps both writes in one transaction. The compensating-delete closes the
  orphan window for the UI flow today; the wrapped RPC is the long-term
  enterprise shape.
- Splitting Inventory-Adjustment into Stock Input / Stock Output accounts à la
  Odoo. Not needed for the SMB SKU set; if/when consignment or in-transit
  valuation lands, revisit.

## Sign-off

- [x] Root cause identified (key vocabulary drift, not a missing role).
- [x] Validator and registry preserved — no bypass, no new role.
- [x] Existing tenants unaffected (mapping rows were already canonical).
- [x] Fresh-tenant opening stock posts cleanly.
- [x] Orphan-product risk closed via compensating delete.
- [x] Architecture guard added to prevent recurrence.
