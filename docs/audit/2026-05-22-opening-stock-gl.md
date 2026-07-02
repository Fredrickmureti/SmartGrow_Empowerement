# Opening stock ↔ GL + product_categories dedupe audit — 2026-05-22

## Verdicts

1. **Opening stock could create inventory without a journal entry.**
   `approve_stock_adjustment_atomic` (migration `20260522154328`) carried a
   carve-out that, when `unit_cost = 0` AND `reason = 'opening_balance'`,
   set `v_resolved_cost := 0` and let the function fall through to
   `IF v_total_value > 0` — which was false. Result: the `stock_movements`
   row was inserted (so `update_product_stock` updated `warehouse_stock`
   and `products.stock_quantity`), the adjustment was marked `approved`,
   but no `journal_entries` row was posted. The UI passed
   `unit_cost: formData.cost_price || 0`, so any product created without a
   cost deterministically tripped the carve-out.

2. **Product categories appeared duplicated because they actually were
   duplicated in the database.** No uniqueness constraint existed on
   `(organization_id, business_id, name, parent_id)`. The
   `load-sample-data` Edge Function inserted the seed set whenever called,
   without `ON CONFLICT`. Verified via:

   ```sql
   SELECT organization_id, business_id, name, parent_id, COUNT(*)
     FROM public.product_categories
    WHERE is_active
    GROUP BY 1,2,3,4
   HAVING COUNT(*) > 1;
   ```

   Live tenant `81695269-…` had 4 root categories duplicated (Consumables,
   Electronics, Services, Office Supplies — each present twice with
   `is_sample_data = true` and ~20 days apart).

## Fix shipped (Wave 11)

Migration `20260522_wave11_opening_stock_gl_and_categories_dedupe.sql`:

- **`approve_stock_adjustment_atomic`** — the zero-cost carve-out is
  removed. Every non-zero adjustment line (including `opening_balance`)
  must resolve to a positive unit cost. On failure the function RAISES
  with `OPENING_STOCK_REQUIRES_COST: …` so the UI can show a clean
  toast instead of a generic 500. The reason-keyed offset resolver
  (Wave 7) already routes `opening_balance` to Opening Balance Equity
  via `ensure_opening_balance_equity_account`, so a successful opening
  stock posts the canonical `DR Inventory / CR OBE` entry.
- **`create_product_with_opening_stock_atomic`** — pre-validates every
  positive opening line for a positive unit cost before inserting the
  product row, so the call fails fast with a clean error and never
  leaves a half-created product.
- **`product_categories` deduplication** — one-time merge: for every
  `(org, business, lower(name), parent_id)` group with count > 1, the
  oldest row is canonical; `products.category_id` and
  `product_categories.parent_id` are re-pointed; the duplicates are
  deleted; a snapshot is written to `audit_logs`
  (`action = 'product_category_dedupe_merge'`).
- **`product_categories_unique_active_name`** — new unique index on
  `(organization_id, business_id, lower(name), COALESCE(parent_id, sentinel)) WHERE is_active`.
  Structurally forbids duplicates from every insert path
  (UI hook, `CategoryResolver`, RPC, sample-data seed).

UI (`src/pages/Products.tsx`):

- Adds per-warehouse **Unit cost** input alongside the opening quantity
  field; defaults from the product cost; surfaces inline `Required > 0`
  validation; client-side guard mirrors the server `OPENING_STOCK_REQUIRES_COST`
  RAISE so we fail before the round trip.
- Success toast now surfaces the journal entry id when a JE was posted.
- Invalidates `journal-entries` cache after a successful opening-stock
  create so the Accounting module reflects the new entry immediately.

Hook (`src/hooks/useProductCategories.ts`):

- Maps unique-violation errors from the new index to "A category with
  that name already exists at this level." instead of the raw Postgres
  error string.

Edge function (`supabase/functions/load-sample-data/index.ts`):

- Category insert tolerates the unique-index conflict by looking up the
  existing row and continuing, so re-seeding (e.g. after a partial
  clear) does not double-insert and does not orphan downstream product
  inserts that reference the category id.

## What is intentionally NOT in this fix

- **Historical opening-stock backfill.** Adjustments that posted
  quantity-only opening stock before this wave are NOT auto-corrected.
  Finance review per period is required. Identify them with:

  ```sql
  SELECT a.id, a.adjustment_number, a.organization_id, a.business_id,
         a.approved_at, sm.product_id, sm.warehouse_id, sm.quantity
    FROM public.stock_adjustments a
    JOIN public.stock_movements sm ON sm.reference_id = a.id
   WHERE a.status = 'approved'
     AND lower(a.reason) = 'opening_balance'
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries je
        WHERE je.source_type = 'stock_adjustment'
          AND je.source_id = a.id
     );
  ```

  For each result, finance can either post a manual correcting JE
  (Inventory DR / Opening Balance Equity CR at the agreed valuation) or
  reverse + re-enter the opening stock through the now-strict UI.

- **Localized OBE account codes per country pack.** OBE is auto-provisioned
  at code `3900` (or `3900-SYS` on clash) by `ensure_opening_balance_equity_account`.
  Country-pack overrides remain queued (ADR 0010).

## Cross-references

- Plan: `.lovable/plan.md` (Wave 11)
- Prior waves: `docs/audit/2026-05-21-inventory-adjustment-gl.md` (Phase A/B),
  `docs/audit/2026-05-21-inventory-adjustment-gl-wave-5.md`,
  `docs/audit/2026-05-21-inventory-adjustment-gl-wave-6.md`.
- ADRs: `0002-costing-method-avco-on-receipt.md`,
  `0016-inventory-adjustment-gl-integrity.md`.
