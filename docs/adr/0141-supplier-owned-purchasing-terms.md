# ADR 0141 — Purchasing terms belong to the supplier-product relationship

- **Status**: Accepted (2026-08-14, Product Domain Foundation wave, Phase 5B)
- **Extends**: ADR 0140 (product domain foundation), ADR 0114 (product identity)

## Context

The parent wave asked whether minimum order quantity, order increment and lead
time are Product master properties. They are not: Supplier A may require MOQ 10
while Supplier B requires 50 for the same item, and both may quote in a
different UoM and currency. `products.min_order_quantity` and
`products.order_quantity_increment` existed as single global values, and the
only code that used them — `src/hooks/useMOQValidation.ts` — performed the
MOQ and increment arithmetic **in the browser**, read the product columns only,
and had no consumers at all.

`supplier_item_terms` already owned supplier, preferred rank, lead time, min
order qty, price breaks, currency and effective dates, so no new table and no
new engine was warranted — only the two missing facts and a read seam.

## Decision

1. **`supplier_item_terms` is the canonical owner** of purchasing terms. It
   gains `order_increment` and `purchase_uom_id` (FK `units_of_measure` — the
   existing UoM engine, not a new unit concept). Supplier SKUs/barcodes stay in
   supplier-scoped `product_identifiers` per ADR 0114; they are not duplicated
   here.
2. **`products.min_order_quantity` / `products.order_quantity_increment` are
   deprecated product-level defaults.** They remain for the product master form
   and are consulted only as the resolver's fallback. Column comments say so.
3. **One resolver**: `resolve_supplier_purchasing_terms(business, product,
   supplier, on_date)` returns MOQ, increment, lead time, currency, purchase UoM
   and unit price, each labelled with its source (`supplier` /
   `product_default` / `system_default`). Effective dating is honoured; an
   expired row falls back rather than being applied. With no supplier named the
   preferred active supplier is used.
4. **Quantity policy is server arithmetic**:
   `validate_supplier_order_quantity(...)` returns
   `QUANTITY_NOT_POSITIVE` / `BELOW_MIN_ORDER_QTY` / `NOT_ON_ORDER_INCREMENT`
   plus the nearest allowed quantity. It reads terms through the resolver, so
   there is one policy, not two.
5. **One client seam**:
   `src/features/products/purchasing/supplierPurchasingTerms.ts`
   (`useSupplierPurchasingTerms`, `validateSupplierOrderQuantity`,
   `describeOrderQuantityVerdict`). `useMOQValidation` is deleted.
6. Both functions are `SECURITY DEFINER`, gated on
   `user_has_business_access`, `authenticated` + `service_role` only; `anon`
   and `PUBLIC` are revoked.

## Consequences

- Purchasing surfaces (PO entry, requisitions, reorder recommendations) will
  consume the resolver in a later wave rather than each re-deriving MOQ.
- Operator copy for a refusal comes from `describeOrderQuantityVerdict`; no
  surface authors its own wording and no SQLSTATE reaches an operator.
- Because terms are effective-dated, changing a supplier's MOQ does not rewrite
  what a historical order was allowed to be.

## Guards

- `supabase/tests/supplier_purchasing_terms_test.sql`
- `src/test/architecture/purchasing-terms-single-owner.test.ts`

## Out of scope

- Supplier-specific packaging hierarchies.
- Dropping the deprecated product columns (still read by the product master
  form and two product read hooks).
