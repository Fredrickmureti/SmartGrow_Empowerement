# Sales Domain Architecture Wave — Authoritative Status

_Last updated: this wave. Active phase: **Phase 3 — COMPLETE**. Next: **Phase 4 — server-authoritative pricing**._

## Phase 3 — The line quantity contract (COMPLETE, verified)

Implemented and verified:

- Quantity precision widened to `numeric(15,4)` on `invoice_items`, `estimate_items`,
  `credit_note_items`, `sales_order_items`, `delivery_note_items`. Dependent views and
  triggers were dropped and rebuilt (`security_invoker` preserved).
- `public.resolve_line_base_quantity(business, product, display_qty, display_uom, packaging)`
  is the single conversion authority. Packaging multiplier wins; alternate UoM goes through
  `convert_uom`; cross-dimension conversions fail closed. Verified live:
  `17.005 KG -> 17005 G`, and `KG` on a `PCE` product raises.
- `_uom_normalize_line()` trigger calls that resolver and is attached to
  `sales_order_items`, `invoice_items`, `estimate_items`, `credit_note_items`,
  `sales_return_items`, `proforma_invoice_items`. `delivery_note_items` uses
  `trg_uom_stamp_delivery_note_items` (it has `quantity_delivered/_ordered`, not `quantity`).
- `proforma_invoice_items` gained `display_quantity`, `display_uom_id`, `packaging_id`.
- `uom_snapshot` is frozen server-side at save time: pack lines get `"Bag × 50 KG"`,
  UoM lines get the unit code. Client never writes it.
- Frontend: `useSellableUnits` + `useUnitsForProducts` produce the `unitsFor` callback;
  `PackagedQtyCell` is the single quantity/unit editor and is used by `PricedLineRow`
  **and** `InvoiceLineRow` (its bespoke packaging math was deleted). `unitsFor` is wired
  into Sales Order create/edit, Estimate create/edit, Credit Note create, Proforma create,
  Invoice create/edit. Client math is a non-authoritative preview only.
- `tsgo --noEmit` clean.

Deliberately out of scope: `CreditNoteEditPage` (lines are locked, no product picker).

## Phase 4 — Server-authoritative pricing (NEXT)

Problem: three competing pricing sources exist and Sales uses the weakest (flat scalar on
product). Client-computed unit price, tax and totals are still trusted by the server.

Milestones, in order:
1. Choose the canonical price resolver (price list > customer group > product scalar) and
   expose it as `resolve_line_unit_price(...)` mirroring the quantity resolver's contract.
2. Stamp price/discount snapshots in a `_pricing_normalize_line()` trigger on the same set
   of line tables.
3. Recompute line tax and document totals server-side; demote client totals to preview.
4. Wire the frontend to display the server-returned price and flag manual overrides.

## Instructions for the next agent

1. **Verify Phase 3 first.** Confirm: the trigger exists on all six line tables; inserting a
   packed line and an alternate-UoM line persists correct `quantity`, `display_*` and
   `uom_snapshot`; no client code writes `quantity` as authority; `tsgo` is clean. Note that
   no `product_packaging` rows exist in the current dataset, so the pack label
   (`"Bag × 50 KG"`) is logic-verified but not data-verified — seed one and confirm.
2. Only after that, start Phase 4 milestone 1. Do not open unrelated domains, and do not
   leave a milestone partially wired across surfaces — each must land on every Sales editor
   before moving on.
