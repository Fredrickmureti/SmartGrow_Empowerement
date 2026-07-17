# ADR 0072 — Product Variants as First-Class Product Rows

**Status:** Accepted (Phase E, 2026-07-17)
**Supersedes:** — **Superseded by:** —

## Context

Enterprise inventory needs variant support (Size × Colour × …) for apparel,
pharma pack sizes, F&B recipes, etc. The connected Supabase carries 298
tables; every downstream inventory system (stock_quants, stock_lots,
stock_serials, stock_movements, product_identifiers, product_pricing,
goods_receipt_items, invoice_items, POS transactions, GS1 barcode
resolution) already keys off `products.id`.

Two viable shapes were considered:

- **A. Self-referencing product hierarchy** — variants are ordinary
  `products` rows joined by `variant_parent_id`; the parent row is a
  non-transacted template.
- **B. Separate `product_variants` table** — variants live in their own
  table and every stock/movement/lot/serial/barcode surface must repoint
  from `product_id` to `variant_id`.

## Decision

**Adopt Option A.** Variants are products. A parent row exists only as a
grouping shell (`is_variant_parent = true`); it is never transacted
against and pickers must exclude it. Each leaf variant is a first-class
product with its own SKU, barcode(s), price, cost, stock, ETIMS codes,
lots, and serials — inherited by copy at generation time, editable
independently thereafter.

## Schema

```
products
  + variant_parent_id     uuid   FK products(id)  NULL for standalone/parent
  + is_variant_parent     bool   default false
  + variant_axis_values   jsonb  e.g. {"Size":"M","Colour":"Red"}

product_variant_axes         (business_id, name)
product_variant_axis_values  (axis_id, value)
```

Invariants (enforced at DB level):

- `variant_parent_id <> id` (no self-parent).
- A row cannot be both `is_variant_parent = true` and have a parent.
- Deleting a parent is `RESTRICT` — variants must be handled first.

## Consequences

**Positive**

- Zero downstream refactor. Every phase-A..H surface keeps working
  because it still resolves by `product_id`.
- GS1 / barcode scanning already routes to the leaf variant (barcodes
  are on `products` via `product_identifiers`).
- Lot genealogy (Phase G) and FEFO allocation are variant-aware for free.

**Negative**

- The `products` table grows in row count (parent + N leaves). Guards
  and reports must filter out `is_variant_parent = true` rows from stock
  totals and transactional pickers.
- Denormalised `variant_axis_values jsonb` on each leaf; the axes catalogue
  is authoritative. UI writes are always via the catalogue picker.

## Non-goals (this ADR)

- Variant-aware bulk import (Phase F).
- Retro-migrating existing "Size-in-name" products into structured axes.
- Per-variant image galleries; `image_url` is inherited from the parent
  until a user overrides it on the leaf.

## Guards

`src/test/architecture/product-variants.test.ts` asserts:

- Migration file exists with the four invariants above.
- Product form imports the variants panel.
- Product pickers used in transactional flows exclude variant parents.
