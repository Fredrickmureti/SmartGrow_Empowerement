## Phase E — Product Variants (audit-first plan)

### Pre-flight verification (done)
- Searched schema on the connected Supabase: **no** `product_variants`, `product_variant_axes`, `product_variant_values`, `product_options`, or `variant_parent_id` columns exist. Only match was the unrelated `v_identity_invariants_violations` view.
- `products` table today carries a single `sku`, `unit_price`, `stock_quantity`, tracking flags, ETIMS fields, UoM refs — no variant axis. Confirms Phase E is greenfield, not a rebuild.
- Prior phases (Lots/Serials, GS1) reference `product_id` directly; introducing variants must not break lot genealogy or FEFO allocation. Design must let each variant be first-class for stock, barcode, price — while keeping the current `products` row as the sellable unit for non-variant products.

### Architecture decision (to capture in ADR 0072)
Two viable shapes:

| Option | Shape | Trade-offs |
|---|---|---|
| **A. Self-referencing product hierarchy** | Add `products.variant_parent_id`, `products.variant_axis_values jsonb`. Each variant is a normal `products` row → inherits all inventory, pricing, ETIMS, accounts columns for free. | Zero downstream refactor. Lot/serial/quant/barcode all keep pointing at `product_id`. Parent row becomes a "template" (`is_variant_parent=true`), never transacted. Slight denormalisation on axis values. |
| **B. Separate `product_variants` table** | `product_variants(id, product_id, sku, barcode, price...)`. Stock/lots/serials repoint to `variant_id`. | Cleaner model, but forces migration of every stock/movement/lot/GS1 code path across 298 tables. High blast radius. |

**Recommendation: Option A.** Keeps the 92+ existing guards and Phase D–H wiring intact. Variants are just products with a parent + axis coordinates.

### Migration (single SQL migration, reversible)
```sql
-- 1. Axis catalogue (per business)
CREATE TABLE public.product_variant_axes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  name text NOT NULL,              -- 'Size', 'Colour'
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE (business_id, name)
);

-- 2. Allowed values per axis
CREATE TABLE public.product_variant_axis_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  axis_id uuid NOT NULL REFERENCES product_variant_axes(id) ON DELETE CASCADE,
  value text NOT NULL,
  display_order int NOT NULL DEFAULT 0,
  UNIQUE (axis_id, value)
);

-- 3. Product-level variant fields
ALTER TABLE public.products
  ADD COLUMN variant_parent_id uuid REFERENCES products(id) ON DELETE RESTRICT,
  ADD COLUMN is_variant_parent boolean NOT NULL DEFAULT false,
  ADD COLUMN variant_axis_values jsonb;  -- {"Size":"M","Colour":"Red"}

CREATE INDEX idx_products_variant_parent ON products(variant_parent_id)
  WHERE variant_parent_id IS NOT NULL;

-- 4. Invariants
ALTER TABLE public.products
  ADD CONSTRAINT chk_variant_parent_not_self
    CHECK (variant_parent_id IS NULL OR variant_parent_id <> id),
  ADD CONSTRAINT chk_parent_xor_child
    CHECK (NOT (is_variant_parent AND variant_parent_id IS NOT NULL));

-- 5. GRANTs + RLS mirror existing products policy (business_id scoped)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_variant_axes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_variant_axis_values TO authenticated;
GRANT ALL ON public.product_variant_axes TO service_role;
GRANT ALL ON public.product_variant_axis_values TO service_role;
ALTER TABLE public.product_variant_axes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variant_axis_values ENABLE ROW LEVEL SECURITY;
-- policies: business_id = current_user_business_id() (match products.tsx pattern)
```

Non-variant products are unaffected (`variant_parent_id IS NULL`, `is_variant_parent=false`).

### UI surface
1. **Product form** — new "Variants" tab: axis picker, value picker, generated matrix (Size × Colour). Each row: SKU, barcode, unit price, cost, initial stock. Bulk-fill helpers.
2. **Product list** — collapse variants under parent; parent shows aggregate stock.
3. **POS / Invoice / GRN pickers** — search hits both parents (expanded) and variant SKUs directly; scanning a variant barcode resolves the variant row (works today because barcodes are on `products`).
4. **Lot / Serial** — no change (still `product_id`).

### Doctrine + guards
- **ADR 0072** — `docs/adr/0072-product-variants.md` capturing the Option-A rationale, invariants, and the "variants are products" doctrine.
- **Guard** — `src/test/architecture/product-variants.test.ts`:
  - Variant parent products never appear in stock movement / invoice line pickers.
  - Barcode resolution routes to leaf variant, not parent.
  - Migration file present, invariants declared.
  - Product form imports the variants matrix component.

### Explicitly deferred (not in this pass)
- Per-variant image gallery (single `image_url` inherited).
- Variant-aware bulk import (belongs in Phase F).
- Retro-migrating existing "size-in-name" products into structured axes.

### Out of scope (unchanged)
- Phase F import split, Phase 5 `warehouse_stock` retirement — remain gated on Phase E landing green.
