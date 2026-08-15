# Purchases — Product / UoM / Packaging consumer audit

## Phase 4 — Requisition → RFQ → PO quantity fidelity (in progress)

Done this turn:

- **F4.0 Trigger order (PO lines)** — `trg_uom_normalize_po_items` renamed to
  `a_uom_normalize_po_items` so the UoM normalizer runs before
  `enforce_line_uom_consistency`. The browser is no longer forced to author the
  base quantity on the primary purchasing document.
- **F4.1 Conversion provenance** — `rfq_convert_awards_to_po` now carries the
  awarded unit (`display_quantity` / `display_uom_id`) and the RFQ line's
  packaging (only when the award did not change unit), and recomputes the PO
  header from the persisted, normalized lines. `requisition_convert_to_po`
  carries `packaging_id` / `display_uom_id`; outstanding demand stays in base
  units and the normalizer derives the supplier-facing quantity.
- **F4.4 Terms gate on conversion** — new
  `_purchase_assert_order_quantity(...)` (SECURITY DEFINER, authenticated +
  service_role) wraps `validate_supplier_order_quantity`; both conversion RPCs
  refuse below-MOQ / off-increment lines before anything is written.
- **F4.3 Pack entry surfaces** — `unitsFor` wired into PO create/edit
  (`PricedLineRow`), RFQ create/edit (`RequestLineRow`, which gained the prop)
  and requisitions (`RequisitionLineRow`, which now renders `PackagedQtyCell`
  instead of a bare numeric input). RFQ lines persist
  `packaging_id` / `display_quantity` / `display_uom_id`.
- MOQ validation on these surfaces now validates the supplier-facing quantity
  (`display_quantity ?? quantity`), matching what MOQ means.

- **F4.2 Price basis resolved** — no second basis was introduced. Unit price is
  per BASE unit on every document in the system (Sales included); purchasing
  now *says so*: `PricedLineRow` renders a `per <base unit>` hint on the price
  cell whenever the quantity is denominated in a pack or an alternate unit.
- **Guard** — `supabase/tests/purchase_conversion_fidelity_test.sql` asserts both
  conversion RPCs carry `packaging_id` / `display_uom_id` and route through
  `_purchase_assert_order_quantity` (SECURITY DEFINER, not anon-executable), and
  that `a_uom_normalize_po_items` is still the first BEFORE trigger on
  `purchase_order_items`.

Open / next:
- Goods receipt / bill line surfaces re-verified against the same contract.
