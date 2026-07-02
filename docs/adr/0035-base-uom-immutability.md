# ADR 0035 — Base UoM is immutable after first transaction

Date: 2026-06-04
Status: Accepted
Related: ADR 0023 (UoM and packaging domain), ADR 0024 (per-base-unit cost scaling on GRN)

## Context

`products.base_uom_id` is the unit every ledger, valuation, cost layer,
reservation and report is denominated in. It was previously editable from
the Product edit form at any time. Two defects were observed:

1. **Stale sibling UoMs.** The form re-synced `sales_uom_id` /
   `purchase_uom_id` to the new base only when they were null
   (`formData.sales_uom_id ?? id`). For existing products with non-null
   siblings, a base change produced a PATCH that mixed UoM categories
   (e.g. `base=KG, sales=PCE`). `enforce_product_uom_category` correctly
   raised `23514`; the operator saw a generic 400.

2. **Silent valuation corruption.** Even if the categories matched, a
   base change (e.g. KG → G, factor 1000×) does NOT rescale
   `stock_quantity`, `warehouse_stock.quantity`, `cost_layers.unit_cost`,
   pricing, or open transactional lines. A product with 487 KG on hand
   would become "487 G" on hand with no conversion — a 1000×
   understatement of stock and value, and an unrecoverable corruption of
   FIFO / AVCO history.

## Decision

`base_uom_id` is **immutable** once a product has any of:

- a row in `stock_movements`
- a row in `cost_layers`
- a non-zero row in `warehouse_stock`
- any row in any transactional line table (`invoice_items`, `bill_items`,
  `purchase_order_items`, `sales_order_items`, `goods_receipt_items`,
  `pos_transaction_items`, `stock_adjustment_items`,
  `stock_transfer_items`, `delivery_note_items`, `credit_note_items`).

A product with zero history may still have its base unit changed, but
only within the **same UoM category** (e.g. KG ↔ G; never KG → PCE).

The single source of truth is the trigger
`public.enforce_base_uom_immutable` (BEFORE UPDATE OF `base_uom_id` ON
`public.products`) which raises:

- `BASE_UOM_LOCKED` (`P0001`) — product has history.
- `BASE_UOM_CATEGORY_CHANGE` (`23514`) — new base is in a different
  UoM category from the old one.

The frontend reads the same probes via the
`useProductUomLock(productId)` hook and disables the Inventory Unit
picker on the Product edit form when locked, surfacing a clear
explanation and pointing the operator at the packaging escape hatch.

## Operator escape hatch

To buy or sell a stocked product in a different unit, add a
`product_packaging` row with the right multiplier against the base unit.
Examples:

- Base `KG`, pack "100 g pack" with `qty_in_base_uom = 0.1`.
- Base `PCE`, pack "Carton of 24" with `qty_in_base_uom = 24`.

Packaging is the only correct way to transact in non-base units; the
existing `_uom_normalize_line` trigger guarantees the ledger always
records the base-unit quantity (see ADR 0023).

## Industry alignment

SAP S/4HANA, Oracle NetSuite, Microsoft Dynamics 365 BC, Odoo, ERPNext
and Acumatica all lock the base / stocking unit after the first
transaction. We follow the same convention.

## What this ADR deliberately does NOT do

- No silent rescaling of `stock_quantity` on base change.
- No automatic conversion of historical movements.
- No "force change" admin override. A genuine rebase requires zeroing
  stock and re-issuing opening balances under the new unit, and is a
  separate, deliberate workflow we have not yet built.

## Defence in depth — `units_of_measure` itself

`enforce_base_uom_immutable` protects `products.base_uom_id`, but the
same corruption can be reached one layer up by editing the
`units_of_measure` row that a transacted product is denominated in
(`factor_to_reference` or `category_id`). A KG → 1000× factor change
would silently rescale every ledger denominated in that unit.

A companion trigger `enforce_uom_immutable_when_in_use` (BEFORE UPDATE
ON `public.units_of_measure`) blocks those two columns from changing
while the UoM is the `base_uom_id` of any product with the same history
footprint as the probes above. Error codes:

- `UOM_FACTOR_LOCKED` (`P0001`) — `factor_to_reference` change blocked.
- `UOM_CATEGORY_LOCKED` (`P0001`) — `category_id` change blocked.

Cosmetic columns (name, code, symbol, `is_active`) remain editable.

## References

- Migration installing `enforce_base_uom_immutable` (2026-06-04).
- Migration installing `enforce_uom_immutable_when_in_use` (2026-06-04).
- `supabase/tests/product_base_uom_immutable_test.sql`.
- `supabase/tests/units_of_measure_locked_when_referenced_test.sql`.
- `src/hooks/inventory/useProductUomLock.ts`.
- `src/pages/Products.tsx` (Inventory unit picker, disabled state).
- `src/hooks/useProducts.ts` + `src/hooks/useProductsPaginated.ts` (mirrored error mapping).
