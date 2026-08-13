# Product Domain — Foundation Audit & Engineering Wave

## What a Product is here

A product is the **authoritative definition of a thing the business trades** — its identity, how it is measured, how it is packed, what it physically is, and how it is classified. It is not a container for what the business currently *owns*. Quantity, cost layers, valuation, reservations and location are transactional facts owned by Inventory. This wave makes the definition side canonical, so Purchasing, Receiving, Warehouse, Landed Cost, Sales, POS, Pricing and Finance can consume product truth instead of inventing it.

## Audit findings (verified against the live database)

**Canonical engines that already exist and MUST be reused — no new engines**

| Capability | Canonical owner |
|---|---|
| UoM conversion | `convert_uom(qty, from_uom, to_uom)` — category-reference factors, cross-category conversion raises |
| Identity resolution | `resolve_product_identity(business, code, branch, allow_sku_fallback, supplier)` |
| Identifier writes | `upsert_product_identifier` / `retire_product_identifier` |
| GL account resolution | `resolve_product_gl_account(org, business, product, purpose)` — 4-tier ladder (ADR 0122) |
| Events | `publish_business_event(...)` → `business_event_outbox` |
| FX | `resolve_exchange_rate` / `require_exchange_rate` (ADR 0135/0136) |
| Pricing | `price_lists` / `price_list_items` (exists, currently under-used) |
| Supplier purchasing terms | `supplier_item_terms` (product × supplier: MOQ, lead time, price tiers, currency, effective dates) |
| Valuation / cost | `cost_layers`, `compute_unit_cost`, `inventory_apply_cost_revaluation` |
| Stock aggregate protection | `guard_products_stock_quantity` triggers + architecture tests |

The foundation is far better than the UI suggests. The gaps are specific, not systemic.

**Confirmed defects**

1. **Physical attributes are unmodelled.** `products` has only `tare_weight` + `weight_unit text` (a free-text POS-scale field with no UoM foreign key). `product_packaging` has no weight, volume or dimensions at all. Consequence, verified in SQL: `landed_cost_allocate_voucher` hard-raises for `weight` and `volume` bases — *"products carry no net weight/volume master data"*. Landed Cost is blocked on the Product domain, exactly as suspected.
2. **Packaging is flat, not nested.** `product_packaging` = `(name, qty_in_base_uom)` only. Piece→pack→box→carton→pallet can be *emulated* as sibling multipliers but nothing validates that carton = 12 × box, and no level can carry its own weight, volume, dimensions or shipping role.
3. **Duplicate ownership of purchasing terms.** `products.min_order_quantity`, `order_quantity_increment` and `cost_price` are global single-supplier facts, while `supplier_item_terms` already models these per supplier with effective dates. Two owners, one truth.
4. **Pricing has two sources.** `price_lists`/`price_list_items` exist, yet `products.unit_price` is what sales/POS read and what price-change triggers watch. The pricing domain is orphaned.
5. **Product creation is not atomic.** Only the opening-stock path uses an RPC. Otherwise saving a product performs sequential client writes — `products.insert`, then per-row `upsert_product_identifier`, then `product_packaging.insert`, then custom fields — each independently try/caught with **no rollback**. The UI even tells the user "product created, packaging save failed". Partial products are a designed-in outcome.
6. **No SKU uniqueness.** `(organization_id, sku)` is a plain index, not unique. Duplicate SKUs are permitted by the database.
7. **Thin lifecycle.** Only `is_active`; no `status`, no `archived_at`. Deletion is a hard client `.delete()` that `ON DELETE RESTRICT` blocks once history exists, surfacing as a raw conflict rather than "archive this product".
8. **Localization leak.** Seven `etims_*` columns sit directly on `products` — Kenya-specific compliance hardcoded into the global product master instead of localization-pack driven attributes.
9. **Landed Cost bypasses the account ladder**, calling `resolve_posting_account(business, purpose, branch)` so product/category GL overrides never apply to capitalization.
10. **Events are one-way.** `product.created` is published; there is no `product.updated` / `product.archived` / `product.physical_attributes_changed`, so consumers cannot react to master-data change.
11. **Monolithic UI.** `ProductForm.tsx` is 1150 lines and carries opening-stock cost rules and a client-side category-account walk mirroring server logic.

Only **4 products** exist in the database, so structural migration is cheap and low-risk right now. This is the correct moment to do it.

## What will NOT change

`convert_uom`, the identity resolver family and its write seam, `resolve_product_gl_account`, the AVCO/cost-layer engine, `products.stock_quantity` as a trigger-guarded derived cache, the split product import configs, and every existing architecture/pgTAP guard. No new UoM, FX, approval, event or valuation engine will be created.

## Plan

**Phase 0 — Architecture report.** `docs/adr/0140-product-domain-foundation.md`: field-by-field ownership matrix for every column on the product form (business fact → owning domain → canonical store → consumers), the scope matrix (system / tenant / business / branch / warehouse / transaction), the event lifecycle, and the target composition. No code changes.

**Phase 1 — Physical attributes (unblocks Landed Cost).** New `product_physical_attributes`, keyed by `(product_id, packaging_id NULLABLE)` so the base unit and each pack level can each carry measurements. Every measure stores a value plus a `units_of_measure` FK — never `weight_kg`-style hardcoded units. Explicitly separated: `net_weight`, `tare_weight`, `gross_weight` (derived/validated, not a third free field), `volume`, `length`, `width`, `height`. Category-guarded so a mass measure cannot be given a length UoM. New `resolve_product_measure(business, product, packaging, measure, target_uom)` reads the attribute and converts through `convert_uom` — one server-side seam Landed Cost consumes. `products.tare_weight` / `weight_unit` are migrated into it and kept as read-only legacy for POS scale flows.

**Phase 2 — Landed Cost integration.** Replace the `RAISE EXCEPTION` for weight/volume bases with allocation over `resolve_product_measure`, normalizing receipt quantities to base units first. Missing measurements produce a named, actionable refusal listing the offending products — fail closed, never silently fall back to value basis. Also route landed-cost capitalization through `resolve_product_gl_account` so the account ladder applies.

**Phase 3 — Packaging structure.** Add `parent_packaging_id` and a shipping-role marker to `product_packaging`, with cycle-safe depth validation and a trigger asserting a child's `qty_in_base_uom` is consistent with its parent's multiplier. Keep the flat `qty_in_base_uom` as the canonical arithmetic field so all existing consumers keep working.

**Phase 4 — Atomic product command.** One `upsert_product_atomic(p_product jsonb, p_identifiers jsonb, p_packaging jsonb, p_physical jsonb)` RPC that validates, writes all children in a single transaction, delegates identifiers to `upsert_product_identifier`, and emits `product.created` / `product.updated` through `publish_business_event`. The form calls it once. Partial products become structurally impossible.

**Phase 5 — Ownership cleanup.** Add the unique `(organization_id, sku)` index (nulls allowed). Add `status` + `archived_at` with an `archive_product` RPC replacing client deletes. Deprecate `products.min_order_quantity` / `order_quantity_increment` in favour of `supplier_item_terms` behind a resolver with company-default fallback. Document `products.unit_price` explicitly as the default/fallback price with `price_list_items` authoritative, and `products.cost_price` explicitly as the WAC cache — no semantic drift. Move `etims_*` product columns behind the localization-pack attribute mechanism.

**Phase 6 — UI decomposition.** Split `ProductForm.tsx` into section components under `src/features/products/`, each fed by the single command. Remove the client-side opening-stock cost rule and the duplicated account walk (display reads a server resolver).

**Phase 7 — Tests.** pgTAP for measure resolution and UoM-category guards, packaging nesting consistency, SKU uniqueness, archive-instead-of-delete, atomic rollback on child failure, tenant isolation, and base-UoM/physical-attribute immutability after transactions. Architecture tests: no client writes to `products`/`product_packaging` outside the command seam; no second measure-conversion implementation. Landed Cost weight/volume allocation gets an integration test proving totals reconcile and missing data refuses.

Phases 1 and 2 deliver the Landed Cost unblock; each later phase is independently shippable.
