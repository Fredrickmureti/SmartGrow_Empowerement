# Sales Domain Wave — Phase 3: the line quantity contract (UoM & packaging)

Authoritative engineering record: `.lovable/plan.md` (this file) plus the
per-phase ledger already established at `docs/plans/sales-domain-live-status.md`.
Phases 0–2 are verified complete there and are not repeated or re-investigated.

## Where the wave stands (from the existing ledger, verified)

- Product identity, UoM conversion (`convert_uom`), packaging
  (`product_packaging.qty_in_base_uom`, `is_sales_default`), physical-measure
  resolution and the reservation engine all exist and are canonical. Sales has
  zero callers of the UoM engine and of packaging.
- Sales owns no product-like table; products reach Sales only through the
  server RPC `list_products_with_branch_stock` — correct shape, but the
  projection carries no `base_uom_id`, no `sales_uom_id` and no packaging
  levels, so a Sales line physically cannot express a customer unit.
- Sales line tables carry `quantity`, `display_quantity`, `packaging_id`,
  `display_uom_id`, `uom_snapshot` — but nothing derives or validates the
  relationship. Base units is only a de-facto contract.
- Pricing (Phase 4) and sale-time tax (Phase 7) remain unowned; they follow
  this phase because a price/tax per unit is meaningless until the unit is
  defined.

## Phase 3 objective

One quantity contract for every Sales line:

```text
customer input (display_quantity + display_uom_id | packaging_id)
        ↓ server-side conversion (convert_uom / qty_in_base_uom)
canonical base quantity  →  reservation, delivery, COGS, inventory movement
        ↓
document + reporting show the customer unit, inventory shows the base unit
```

The customer-facing quantity must stay auditable; the base quantity must stay
canonical. No conversion in React may be authoritative.

## Work items

1. **Widen the Product read seam (Product domain change, Sales consumes).**
   Extend `list_products_with_branch_stock` to return `base_uom_id`,
   `sales_uom_id`, base/sales UoM codes and the product's sellable packaging
   levels with `qty_in_base_uom` and `is_sales_default`. No second product
   query in Sales; `useBranchScopedProducts` types widen accordingly.

2. **Server-side conversion helper (UoM domain, not Sales).**
   A single resolver that takes (product, display_quantity, display_uom_id |
   packaging_id) and returns the base quantity plus the snapshot fields,
   rejecting cross-dimension conversions and unknown packaging. Sales calls it;
   Sales does not implement it.

3. **Make the atomic RPCs derive, not trust.**
   `create_sales_order_atomic`, the estimate/proforma/invoice/credit-note
   creators and the delivery creator derive `quantity` (base) from the
   customer-facing input via the resolver, persist `display_quantity`,
   `display_uom_id`, `packaging_id` and a structured `uom_snapshot`, and reject
   a client-supplied base quantity that disagrees.

4. **Declare and enforce the contract in the schema.**
   Column comments stating the unit of `quantity`; widen
   `invoice_items.quantity` and `estimate_items.quantity` from `numeric(10,2)`
   (which silently rounds 17.005 kg) to the `numeric(15,4)`-class precision used
   by inventory; consistent precision across all Sales line tables.

5. **Line editor captures the sell unit.**
   `PricedLineRow` (and the invoice row) gain a unit/packaging selector fed by
   the widened projection, defaulting to `is_sales_default` / `sales_uom_id`.
   The base-unit equivalent is shown as a server-confirmed preview only.

6. **Close the `uom_snapshot` split.**
   The database column is `text`; `src/services/documents/snapshots/lineItemUom.ts`
   accepts a string or an object. Settle on one representation and migrate
   readers.

7. **Route the manual product picker through the ADR 0114 identity seam** so a
   picked line receives the same `packaging_id` / `qty_in_base_uom` provenance a
   scanned line already gets.

## Verification (evidence recorded in the ledger, not in chat)

Proven end to end against the live database, per scenario:

- bulk: sell 17.005 kg of a product stocked in kg — no rounding, inventory
  deducts 17.005;
- packaged: sell 1 bag and 3 bags of a 50 kg bag product — inventory deducts
  50 / 150, the document still says "3 bags";
- pieces from a carton of 24 — sell 6 pieces;
- invalid: mass→count conversion is rejected server-side;
- a client posting a base quantity inconsistent with its display quantity is
  rejected;
- reservation, delivery completion and COGS all consume the base quantity.

## Out of scope for this phase

Pricing ownership (Phase 4), sale-time tax resolver (Phase 7), warehouse
selection (Phase 6), idempotency (Phase 10), reporting surfaces (Phase 14).
Any upstream defect found is fixed in its own domain or the phase is marked
blocked — never worked around inside Sales.

## Technical notes

Database changes ship as migrations (RPC signature change plus column
precision and comments). `docs/plans/sales-domain-live-status.md` is updated at
the end of the phase with evidence, verdicts and the next active phase; this
file tracks the wave-level state.
