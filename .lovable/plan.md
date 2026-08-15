# Sales Domain Architecture Wave — Authoritative Status

_Active phase: **Phase 4 — server-authoritative pricing** (milestones 1, 2 and 4 COMPLETE; milestone 3 PENDING). Next: Phase 4 milestone 3 — server-side tax and document totals._

## Phase 3 — The line quantity contract (COMPLETE, verified)

- Quantity precision widened to `numeric(15,4)` on `invoice_items`, `estimate_items`,
  `credit_note_items`, `sales_order_items`, `delivery_note_items`; dependent views/triggers
  rebuilt with `security_invoker` preserved.
- `public.resolve_line_base_quantity(...)` is the single conversion authority (packaging
  multiplier wins, alternate UoM via `convert_uom`, cross-dimension fails closed).
  Verified live: `17.005 KG -> 17005 G`; `KG` on a `PCE` product raises.
- `_uom_normalize_line()` attached to `sales_order_items`, `invoice_items`, `estimate_items`,
  `credit_note_items`, `sales_return_items`, `proforma_invoice_items`;
  `delivery_note_items` uses `trg_uom_stamp_delivery_note_items`.
- `uom_snapshot` frozen server-side (`"Bag × 50 KG"` for packs, unit code otherwise).
- Frontend: `useSellableUnits` / `useUnitsForProducts` + `PackagedQtyCell` wired into all
  Sales editors. Client math is preview only.

Out of scope by design: `CreditNoteEditPage` (lines locked, no product picker).

## Phase 4 — Server-authoritative pricing (ACTIVE)

### Milestone 1 — canonical resolver (COMPLETE, verified)
`public.resolve_line_unit_price(...)` returns `{unit_price, source, price_list_id,
discount_percent, factor}` with precedence: customer price list (incl. qty tiers) >
business price book (incl. packaging-specific price) > product scalar. Unit-aware: scales
by the base-unit factor from the Phase 3 quantity contract.

### Milestone 2 — server stamping (COMPLETE, verified)
- `price_source` column added to `invoice_items`, `sales_order_items`, `estimate_items`,
  `credit_note_items`, `proforma_invoice_items`.
- `_pricing_normalize_line()` trigger (`trg_zz_*`, runs after UoM normalization) stamps
  unit price, provenance and customer-group discount on insert/update, preserving explicit
  manual overrides (`price_source = 'manual'`).

### Milestone 4 — frontend preview of server price (COMPLETE)
- `src/hooks/useLinePriceResolver.ts`: `useLinePriceResolver` (RPC) and
  `useServerPriceApplier` (async apply into line state).
- Wired into every Sales editor: Sales Order create/edit, Estimate create/edit,
  Invoice create/edit, Proforma create, Credit Note create. Each editor re-prices on
  product, packaging or display-UoM change; the product scalar is only an optimistic
  placeholder. `useCallback` dep arrays include `applyServerPrice` (no stale customer).
- `tsgo --noEmit` clean.

### Milestone 3 — server-side tax and totals (PENDING — do this next)
Still client-authoritative: line `tax_amount`, `line_total`, and document
`subtotal / tax_total / total`. Required work:
1. `resolve_line_tax(...)` (or extend `_pricing_normalize_line`) to compute
   `discount_amount`, `tax_amount`, `line_total` from stamped price × base quantity and the
   product/customer tax rule; stamp them in the same trigger.
2. Document-level totals recomputed by trigger on line insert/update/delete for all six
   document types; block direct client writes to total columns.
3. Demote client totals to display-only preview across the editors and print views.

## Instructions for the next agent

1. **Verify Phase 4 milestones 1, 2 and 4 first.** Confirm: `resolve_line_unit_price`
   precedence with a seeded price list, price book and packaging row; the `trg_zz_*` trigger
   fires after `_uom_normalize_line` on all five line tables; a manual override survives an
   update; every Sales editor shows the resolved price after picking a product/unit;
   `tsgo` clean. Note: no `product_packaging` or `price_list_items` rows exist in the
   current dataset, so packaging-specific and tiered pricing are logic-verified only —
   seed rows and confirm.
2. Only then start Phase 4 milestone 3 above. Land it on every Sales document type before
   moving on; do not open unrelated domains and do not leave partial wiring.
