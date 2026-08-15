---
name: supplier-owned-purchasing-terms
description: Purchasing policy (MOQ, order increment, purchase UoM, lead time) is owned by supplier_item_terms and resolved/enforced server-side, never in the browser.
type: constraint
---
- Purchasing terms live on the supplier↔product relationship: `supplier_item_terms` (+ `order_increment`, `purchase_uom_id` FK `units_of_measure`). Effective-dated rows win over product-level defaults (ADR 0141).
- ONE resolver: `resolve_supplier_purchasing_terms(business, product, supplier, on_date)`; ONE enforcer: `validate_supplier_order_quantity(...)` returning `BELOW_MIN_ORDER_QTY` / `NOT_ON_ORDER_INCREMENT` / `QUANTITY_NOT_POSITIVE`. Both SECURITY DEFINER, `authenticated`-only (`anon` revoked).
- Single client seam: `src/features/products/purchasing/supplierPurchasingTerms.ts`. No other file may `.rpc()` these functions, and no browser file may compare/modulo `min_order_quantity` / `order_quantity_increment`. Guard: `src/test/architecture/purchasing-terms-single-owner.test.ts`; SQL: `supabase/tests/supplier_purchasing_terms_test.sql`.
- The supplier argument accepts either the purchasing party (`contacts.id`, what documents carry as `vendor_id`) or the supplier role (`suppliers.id`); the server does the hop via `_resolve_supplier_role_id`. The browser never maps party→role.
- Purchases reaches terms only through its adapter `src/features/purchases/purchasingTerms/purchaseLineTerms.ts` (defaults on product pick + MOQ/increment refusal on submit for PO create/edit and requisition create).
- `products.min_order_quantity` / `order_quantity_increment` are deprecated FALLBACK defaults only; the product master renders them via `PurchasingDefaultsSection` (edit-only, no arithmetic). `useMOQValidation` is deleted and must never return.
