# ADR 0140 — Product Domain Foundation: physical attributes, ownership and scope

Status: Accepted (wave 1 of the Product foundation programme)
Supersedes: nothing. Complements the UoM engine (`convert_uom`), the identity
resolver (`resolve_product_identity`) and the Finance account resolver.

## Context

The Landed Cost investigation surfaced a Product-domain gap, not a Landed Cost
gap: `landed_cost_allocate_voucher` hard-raised on `weight` and `volume`
allocation bases because "products carry no net weight/volume master data". The
`products` table held no weight, volume or dimensions at all — only a free-text
`tare_weight` / `weight_unit` pair used by POS scale barcodes.

Any module that needed a physical fact therefore had two bad options: invent its
own field, or refuse to work. Both produce competing versions of product truth.

## Decision

### 1. The Product domain owns physical characteristics; nobody else does

A new entity, `product_physical_attributes`, holds the physical facts of a
product **at a measurement level**:

- level = the base inventory unit (`packaging_id IS NULL`), or
- level = a specific `product_packaging` row (pack, box, carton, pallet).

Facts stored: `net_weight`, `tare_weight`, `gross_weight`, `volume`,
`length`/`width`/`height`. Each measurement carries **its own UoM reference**.

This is deliberately not on `products`: physical facts vary per packaging level,
so putting them on the master row would either lose information or force a
Product God Object. It is also deliberately not on `product_packaging`: base-unit
measurements exist for products with no packaging at all.

### 2. No hardcoded units. Ever

There is no `weight_kg`, `volume_l` or `weight_lb` column. Every measurement
points at `units_of_measure`, and conversion is performed exclusively by the
existing `convert_uom` engine. `uom_categories` gained a `dimension` column
(`count | mass | volume | length | area | other`) so the domain can assert that
a weight uses a mass unit and a volume uses a volume unit. The canonical seeder
`seed_default_uom_for_business` was extended with Volume (L, mL, cm³, m³) and
Length (cm, mm, m, in, ft) families — as **system defaults per business**, not as
code constants.

### 3. Net vs tare vs gross is explicit, and gross is derived

`gross_weight` is never a free-hand third number. The database trigger
`trg_enforce_physical_attribute_integrity`:

- derives `gross_weight = net_weight + tare_weight` (tare converted into the net
  unit) when gross is absent;
- rejects a supplied gross weight that disagrees with net + tare beyond a 0.5%
  tolerance;
- rejects a gross weight that does not exceed tare;
- requires a measurement and its unit together;
- rejects a unit from the wrong dimension or another business;
- rejects a packaging level belonging to another product;
- rejects an organization/business that disagrees with the product.

These are domain invariants, so they live in the database — not in the form.

### 4. One read seam for the whole ERP

`resolve_product_measure(business, product, packaging, measure, target_uom)` is
the only sanctioned way to read a product measurement. It:

1. reads the exact measurement level;
2. falls back from a packaging level to the base level × `qty_in_base_uom`;
3. converts into the caller's target unit (or the business's reference unit for
   that dimension) via `convert_uom`;
4. returns `NULL` when the fact is unknown, so callers **fail closed**.

Downstream modules must call this. They must not read
`product_physical_attributes` columns and do their own arithmetic.

### 5. Landed Cost consumes, it does not own

`landed_cost_allocate_voucher` now supports `weight` and `volume` bases. Per
receipt line the basis is `quantity_received × resolve_product_measure(...)`,
weight preferring gross and falling back to net. If any product in scope lacks
the fact, allocation aborts and names the offending products. Silent
misallocation is worse than a blocked posting.

### 6. Legacy fields are demoted, not silently reused

`products.tare_weight` / `products.weight_unit` remain for POS scale barcodes
and are now commented as legacy. Existing values were migrated into the
canonical entity as base-level tare weights.

## Scope matrix (facts settled by this wave)

| Fact | Owner | Scope |
| --- | --- | --- |
| Net / tare / gross weight, volume, dimensions | Product domain (`product_physical_attributes`) | Organization + business, per product, per measurement level |
| Unit definitions and conversion | UoM engine (`units_of_measure`, `convert_uom`) | Business |
| Which dimension a unit family measures | `uom_categories.dimension` | Business (system-seeded default) |
| Packaging multipliers | `product_packaging` | Business, per product |
| Stock quantity and valuation | Inventory / cost-layer engines | Warehouse, transactional |
| Landed cost allocation basis values | Landed Cost, computed per voucher from Product facts | Transactional snapshot |

## Consequences

- Weight/volume freight allocation is possible without any new engine.
- Warehouse capacity, shipping and future manufacturing read the same facts.
- Product creation still creates no inventory: nothing here touches stock.
- Products missing measurements block physical-basis allocation by design; the
  error names them so data can be completed.

## Explicitly not changed in this wave

- `products.cost_price` / `unit_price` semantics (pricing and costing waves).
- Supplier-product terms (`supplier_item_terms`) and global MOQ fields.
- The atomic product write path (`upsert_product_atomic`), packaging nesting,
  SKU uniqueness and the `ProductForm` decomposition — later phases of this
  programme.
