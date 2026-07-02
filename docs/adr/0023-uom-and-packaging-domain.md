# ADR 0023 — Units of Measure and Packaging Domain

Date: 2026-06-08
Status: Accepted
Supersedes: parts of ADR 0002 (costing-method-avco-on-receipt) on the
question of where unit cost is derived from.

## Context

The ERP must support products that are purchased, stored, and sold in
different units (carton / box / strip / piece / kg / liter / roll / meter).
The previous model assumed `quantity` was always "one item = one stock
unit", which falls apart for supermarkets, pharmacies, wholesalers,
hardware stores, and any business that buys in cartons and sells in pieces.

This ADR codifies the model introduced in migrations `20260527131853`,
`20260527132826`, `20260527141306` and corrected in the 2026-06-08 re-audit.

## Decision

### Canonical units

For every product:

- `products.base_uom_id` — the **atomic** stock unit. Every quantity in
  every ledger, every report, every reservation, and every cost layer is
  expressed in this unit. There is exactly one base UoM per product.
- `products.sales_uom_id` — operator default for sales-side UI.
- `products.purchase_uom_id` — operator default for purchase-side UI.
- These default to the business's reference UoM (`PCE` for normal products,
  `KG` for `is_weighted`) via the `tg_default_product_uom` trigger.

### Packaging

`product_packaging` is the **named multiplier** table:
- `name` — operator-facing label ("Carton of 24", "Strip of 10").
- `qty_in_base_uom` — strict numeric multiplier against `base_uom_id`.
- `barcode_id` — optional FK into `product_identifiers`; scanning that
  barcode resolves directly to this pack via `resolve_barcode_v2`.
- `is_purchase_default` / `is_sales_default` — operator-facing defaults.

Packaging carries **no UoM column of its own**. The pack multiplier
relative to base IS the conversion. The display UoM on a line is the
product's `base_uom_id` whenever a `packaging_id` is set.

### Line tables

Every operational line table (invoice_items, sales_order_items,
purchase_order_items, goods_receipt_items, pos_transaction_items,
stock_adjustment_items, stock_transfer_items) carries:

- `quantity` (or `quantity_received` for GRN) — **canonical base units**.
  Immutable contract: every consumer reads this column.
- `display_quantity` — what the operator entered ("3").
- `display_uom_id` — UoM the operator chose; nullable; defaults to base.
- `packaging_id` — which `product_packaging` row was selected; nullable.

The BEFORE-INSERT/UPDATE trigger `_uom_normalize_line` (and the GRN
variant) enforces the invariant: when `packaging_id` or `display_uom_id`
is set, `quantity` is recomputed as the canonical base-unit value. After
R8 (2026-06-08), an UPDATE that touches only `quantity` skips this branch.

### Stock movements ledger

`stock_movements` is the immutable ledger (enforced by
`enforce_stock_movement_immutability`). Every row carries:

- `quantity` — base units.
- `source_packaging_id` — provenance of which pack produced the movement.
- `source_uom_id` — provenance of the display UoM.

These are populated by `process_pos_transaction` directly; for other
movement sources (invoice confirm, GRN approve, stock adjustment approve,
stock transfer) the AFTER-INSERT trigger `_backfill_movement_packaging`
resolves the originating line via `(reference_type, reference_id, product_id)`.

### Cost model

`businesses.cost_model` ∈ {`wac`, `fifo`}:

- `cost_layers` and `cost_layer_consumptions` are maintained on **every**
  movement regardless of toggle. This keeps the option to switch later
  without rebuilding history.
- The single read site for unit cost is the `compute_unit_cost(business_id,
  product_id, warehouse_id)` helper. It branches on `cost_model` and reads
  `v_cost_layer_basis.fifo_unit_cost` (FIFO) or `products.cost_price`
  (WAC). All COGS sites SHOULD migrate to call this helper instead of
  reading `products.cost_price` directly. (Migration of existing call
  sites is tracked separately — see audit 2026-06-08 "Open work".)

### Barcode resolution

`resolve_barcode_v2(business_id, branch_id, code)` is the single entry
point. Resolution order:

1. Direct hit on `product_packaging.barcode_id` → returns
   `(product_id, packaging_id, qty_in_base_uom)`.
2. Fallback to legacy `pos_resolve_barcode` (weighted-EAN rules, sku,
   gtin, pack-quantity identifiers).

The packaging-barcode binding is set from the `ProductPackagingEditor`
UI (added in R3, 2026-06-08).

## Consequences

- **Universal across industries.** Supermarkets, pharmacies,
  wholesalers, hardware stores, restaurants, manufacturing all model the
  same way: one product, one base unit, many named packs.
- **No duplicated products** for box/pack/piece. Reporting, valuation,
  and reservations work on base units; UI translates at the edges.
- **Ledger and accounting remain valuation-safe.** Cost layers track in
  base units regardless of how the operator entered the line.
- **Backward compatible.** Lines without `packaging_id` continue to
  behave exactly as before — `display_quantity` defaults to `quantity`,
  `display_uom_id` defaults to the product's base UoM.
- **Cost model is honest.** Switching `cost_model` only takes effect for
  call sites that use `compute_unit_cost`. Sites still reading
  `products.cost_price` directly remain on WAC until migrated; a
  recosting RPC for historical re-valuation is explicitly out of scope
  for this ADR.

## Open questions

- **Multi-UoM pricing.** Selling a carton at 22 KES and a piece at 1 KES
  is not yet supported (single `unit_price` per product). A
  `product_pricing(packaging_id, price)` table is the proposed extension.
- **Per-warehouse FIFO scoping.** `cost_layers` are scoped by
  `(business_id, product_id, warehouse_id?)` with a NULL fallback. Strict
  per-warehouse layers may be needed for regulated industries.
- **Lot/serial × packaging.** Schema supports both; UI does not yet
  surface lot/serial selection per pack.

## References

- Migration `20260527131853` — domain tables, products columns, seed
  function, line columns, `convert_uom`, `resolve_barcode_v2`.
- Migration `20260527132826` — normalization triggers, cost layer
  maintenance, `v_cost_layer_basis`.
- Migration `20260527141306` — `pos_resolve_barcode` v2,
  `process_pos_transaction` packaging propagation, `cost_model` column.
- Audit `docs/audit/2026-06-08-uom-packaging-reaudit.md`.
