# Inventory adjustment ↔ GL integrity audit — 2026-05-21

## Verdict

Confirmed: manual stock adjustments from `src/pages/Inventory.tsx` could
change `warehouse_stock` and `products.stock_quantity` **without producing
a journal entry**, while the RPC still returned `success: true`. Opening
stock, Physical Count, and Scrap were not affected — those flows already
passed `unit_cost` to the server.

## Root cause (one paragraph)

`approve_stock_adjustment_atomic` computed `v_cost = ABS(qty) * COALESCE(unit_cost, 0)`
and only entered the `post_journal_entry_atomic` branch when the running
totals were non-zero. The Inventory adjustment dialog never collected
`unit_cost`, so totals stayed at zero, the GL branch was skipped, and the
adjustment was still marked `approved`. The `update_product_stock`
trigger on `stock_movements` then moved quantity regardless. There was no
UI signal that GL had been skipped (`gl_posted:false` was returned but the
success toast ignored it). The architecture delegated valuation to the
caller with no server fallback.

## Fix shipped (Phase A + B)

Migration `20260521005751_b1e67397-2ccb-40cc-830b-9f1912197109.sql`:

- New function `resolve_adjustment_unit_cost(org, biz, product, warehouse, provided)`
  resolving cost in order: caller-provided → `warehouse_stock.average_cost`
  → `products.cost_price` → last inbound `stock_movements.unit_cost`.
- New column `warehouse_stock.average_cost` so each warehouse keeps its
  own moving-average baseline.
- Hardened `approve_stock_adjustment_atomic`:
  - locks the per-warehouse stock row with `FOR UPDATE` while computing,
  - resolves cost server-side per line,
  - **RAISES** when no valuation cost can be resolved for a non-zero line
    instead of silently posting a zero-value adjustment,
  - persists the resolved cost back onto the adjustment line and the
    resulting stock movement,
  - provisions GL accounts up front (fast-fail if missing),
  - always returns `gl_posted`, `journal_entry_id`, `total_value`.
- Extended `update_weighted_avg_cost_on_receipt` to also fire for
  `adjustment` movements with positive quantity AND a real `unit_cost`, so
  "found stock" adjustments contribute to the running average — both at
  the company level (`products.cost_price`) and the per-warehouse level
  (`warehouse_stock.average_cost`).

UI (`src/pages/Inventory.tsx`):

- Adjustment dialog now has a required `Unit cost` field per line, pre-
  filled with the product's current `cost_price` when a product is chosen.
- The "Reason" field is now an enum (`shrinkage`, `damage`,
  `count_variance`, `found_stock`, `write_off`, `revaluation`,
  `opening_balance`) — it will drive reason-keyed offset accounts in
  Phase D.
- Submit handler validates that every non-zero line has a positive cost
  before calling the RPC.

Hook (`src/hooks/useInventory.ts`):

- Success toast now explicitly distinguishes "journal entry posted" from
  the (now-unreachable) "NO journal entry was posted" warning so any
  future regression is loud.

Architecture guard:

- `src/test/architecture/inventory-adjustment-cost-resolution.test.ts`
  locks in the migration shape, the dialog shape, and the toast contract.

## What is intentionally NOT in this fix

- Reason-keyed offset accounts (Phase D1) — the dialog already collects
  the reason; the GL still uses a single `adjustment_account_id` until
  Phase D ships.
- Reversal RPC and immutability trigger (Phase D2/D3).
- Historical backfill — adjustments that posted without GL before this
  migration are NOT auto-corrected. A finance review per period is
  required; the query identifying them is:

  ```sql
  SELECT a.id, a.adjustment_number, a.organization_id, a.business_id,
         a.approved_at
    FROM public.stock_adjustments a
   WHERE a.status = 'approved'
     AND NOT EXISTS (
       SELECT 1 FROM public.journal_entries je
        WHERE je.source_type = 'stock_adjustment'
          AND je.source_id = a.id
     );
  ```

## Cross-references

- Plan: `.lovable/plan.md`
- Existing guards preserved: `inventory-adjustment-posting.test.ts`,
  `no-hardcoded-draft-stock-adjustment.test.ts`,
  `no-direct-stock-aggregate-writes.test.ts`,
  `sales-inventory-integrity.test.ts`.