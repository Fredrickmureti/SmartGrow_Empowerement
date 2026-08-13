---
name: Multi-Unit Inventory Display Contract
description: Base qty is the source of truth; pack rollups are presentation. Cells rendering warehouse_stock.quantity must use formatQtyWithPacks with the product's packaging rows.
type: feature
---

# Multi-unit inventory — display contract

The Inventory engine stores everything in BASE units (warehouse_stock.quantity,
stock_movements.quantity, cost_price, unit_price). `product_packaging` rows
(`name`, `qty_in_base_uom`) are a pure presentation layer.

## Rules

1. Never store or write a pack quantity. Convert to base units before any
   insert/update.
2. Every UI surface rendering a stock quantity should funnel through
   `@/lib/inventory/formatQty`:
   - `formatBaseQty(qty, baseLabel)` — base only ("240 ea")
   - `formatQtyAsPacks(qty, packs, baseLabel)` — largest pack + remainder ("10 Box")
   - `formatQtyWithPacks(qty, packs, baseLabel)` — both ("10 Box (240 ea)")
   - `decomposeQty` — full per-pack decomposition (for the converter UI)
3. Per-pack barcodes live in `product_identifiers.packaging_id`; the base
   barcode is the row with `packaging_id IS NULL`.
4. Per-pack pricing is DERIVED (no purchase_price / sales_price columns on
   product_packaging). UI must compute as `unit_price * qty_in_base_uom`
   and `cost_price * qty_in_base_uom`.
5. `products.base_uom_id` is **immutable** once a product has any stock
   movement, cost layer, non-zero warehouse stock, or row in any
   transactional line table (ADR 0035). Enforced by trigger
   `enforce_base_uom_immutable`; pre-flight via `useProductUomLock`.
   To buy/sell in a different unit, add a `product_packaging` row.
   Sales/purchase UoMs must always share a category with the base UoM
   (enforced by `enforce_product_uom_category`); when the operator
   changes base on an unlocked product, the form re-syncs both siblings
   to the new base (never `?? id`).
6. `units_of_measure.factor_to_reference` and `category_id` are
   **immutable** while the row is the `base_uom_id` of any transacted
   product (ADR 0035 — defence in depth). Enforced by trigger
   `enforce_uom_immutable_when_in_use`. Cosmetic columns (name, code,
   symbol, is_active) remain editable.



## Replenishment intelligence

`@/lib/inventory/replenishmentSignal.ts` is the canonical derivation of
days-of-supply and tier (out-of-stock / critical / low / healthy /
overstock / no-velocity / untracked). Velocity = 28-day outbound base qty /
4 weeks. Used by ProductDetailPanel, OverviewTab, and (planned) listings.

## Conditional product detail tabs

Tabs in `ProductDetailPanel.tsx` render via a single registry filtered by
the product's configuration. Order: Overview, Stock, Lots & Expiry,
Units & Packaging, Valuation, Movements, Suppliers, Accounting, Activity.
Non-inventory and service items hide stock-related tabs.

## Costing

ADR-0002: AVCO on receipt (NOT FIFO). The ValuationTab badge says "AVCO" —
do not change copy to FIFO without an ADR amendment.

## Phase 3–4 (2026-08-13) — nested packaging + atomic product save
- `product_packaging` now has `parent_packaging_id`, `qty_in_parent`, `is_shipping_unit`. `qty_in_base_uom` stays CANONICAL for all arithmetic; `qty_in_parent` is derived when omitted. `trg_enforce_packaging_hierarchy` refuses cycles, cross-product/business parents, depth > 8, and any child whose base quantity contradicts parent × qty_in_parent; `trg_repropagate_packaging_children` refuses a parent quantity change that would contradict a nested level. One shipping unit per product (partial unique index).
- Product saves go through ONE transaction: `save_product_atomic(p_product, p_product_id, p_packaging, p_physical, p_identifiers)` — master + packaging + physical attributes + identifiers, all-or-nothing. Identifier writes inside it delegate to `upsert_product_identifier` / `retire_product_identifier` (never direct table writes). New packaging levels are referenced by measurement/identifier rows in the same payload via `client_key` / `parent_client_key` / `packaging_client_key`.
- Client seam: `src/features/products/save/saveProductAtomic.ts` (`saveProductAtomic`, `describeProductSaveFailure`). Operator copy for save failures comes from there — no raw SQLSTATE in toasts. Opening stock stays on `create_product_with_opening_stock_atomic` (ledger path unchanged).
- Guard: `supabase/tests/product_packaging_hierarchy_test.sql`.
- `ProductForm` submits ONE `saveProductAtomic` call for create and edit; the child editors expose `collect()` payloads (`commit()` survives only for their standalone save buttons). Never reintroduce best-effort child writes after the master save. Guard: `src/test/architecture/product-save-single-transaction.test.ts`.
