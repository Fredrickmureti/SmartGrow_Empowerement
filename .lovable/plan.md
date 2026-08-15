# Product UoM / Packaging / Quantity — Audit Verdict & Remediation

## 1. Executive verdict: **partially sound, with fragmented consumers**

The domain model is real, not accidental. The database genuinely separates
unit-of-measure from packaging, stores every quantity in base units, and
defends the invariant with triggers. It is **not** true that a new model is
needed. It is **also not** true that "the data model is correct, the
presentation layer is wrong" — that earlier conclusion is roughly 80% right
and materially wrong in three places (ledger provenance, client-side
conversion in receiving, purchase-order normalization).

So: the ERP does understand what `383` means at the ledger level. It loses
that understanding at specific seams.

## 2. What is canonical (proven)

- `products.base_uom_id` / `sales_uom_id` / `purchase_uom_id` — all FK'd to
  `units_of_measure`, category-consistency enforced by
  `enforce_product_uom_category`, base UoM immutable once transacted
  (`enforce_base_uom_immutable`).
- **There is no legacy `products.unit_of_measure` column.** It does not exist
  in the schema or in migration history. The UI code reading
  `(product as any).unit_of_measure ?? "ea"` is reading a field that is
  *always undefined* — so it always renders "ea". That is the root cause of
  `383 ea`, and it is a P1 correctness defect, not cosmetic.
- `units_of_measure`: category_id (NOT NULL), factor_to_reference, rounding,
  tenant-scoped. `convert_uom()` refuses cross-category conversion — kg→L and
  piece→kg are blocked.
- `product_packaging`: qty_in_base_uom canonical, nested hierarchy with cycle
  and consistency triggers, one shipping unit per product, barcodes via
  `product_identifiers.packaging_id`.
- Provenance columns (`quantity` base + `display_quantity` + `packaging_id` +
  `display_uom_id` + `uom_snapshot`) exist on all 10 document-line tables and
  are guarded by `enforce_line_uom_consistency` on 14 tables.
- Quantities are `numeric(15,4)` — fractional weight/volume/length supported.
- `resolve_line_base_quantity()` is the single conversion rule.

## 3. Findings by severity

### P0 — integrity risk
1. **Receiving converts on the client.** `ReceivingSessions.tsx` computes
   `baseUnits` via `toBase()` and sends the already-converted number to the
   capture RPC. A stale or wrong client packaging factor writes a wrong base
   quantity into stock. Server must convert from `(packaging_id, entered qty)`.
2. **`purchase_order_items` has no base-normalization trigger.** The code
   comment claims "DB trigger normalizes"; no such trigger exists. PO lines are
   inserted by a raw client insert. If the UI ever sends pack quantity as
   `quantity`, the PO is wrong by the pack factor with nothing to catch it.

### P1 — domain correctness
3. **`stock_movements`, `warehouse_stock`, `stock_quants` carry no
   `uom_snapshot`/`display_quantity`.** The ledger cannot explain a movement in
   commercial terms without joining back to the source line.
4. **`unit_of_measure ?? "ea"` in 8 UI sites** — 5 product-detail tabs,
   `ProductDetailPanel` (×2), `useDashboardIntelligence`. Always resolves to
   "ea". Fix: `baseUomLabel(product.base_uom)`.
5. **Invoice/POS/returns confirm-path bodies unverified.** `_confirm_invoice_core`,
   `process_pos_transaction`/`_pos_insert_line`/`_pos_write_stock_movement`,
   `create_sales_return_atomic`/`_resolve_credit_note_line` were not read. The
   `100 ea` invoice suggests at least one document surface bypasses the
   formatter; this must be confirmed before any code change.
6. **POS cannot manually enter fractional weight.** `POSUnitSelectDialog`
   clamps with `Math.max(1, Math.floor(...))`, `step={1}`. So "2.5 L" or
   "17.3 kg" is only sellable via a weight-embedded scale barcode. Packaging
   selection and `1 × 50 kg Bag` **do** work.
7. **Packaging has no "not applicable to this channel" flag** — only
   `is_purchase_default` / `is_sales_default`. Every pack level is implicitly
   sellable and purchasable.

### P2 — reporting / consistency
8. **Four parallel quantity formatters**: `formatQty.ts`,
   `packagingRollup.ts`+`useQtyFormatter.ts`, the Deno
   `LineItemsTable.formatQtyCell`, and `receipt/items.ts`. Same maths today; no
   test pins them together.
9. `formatLineQty`/`formatLineQtyString` in `uom.ts` appear to have **no live
   importers** — documented as mandatory, actually dead.
10. Document kinds bypassing `LINE_ITEM_UOM_SELECT`: `purchasesRequisition`,
    `purchasesRfq`, `wmsReturn`. `purchasesGrn` inlines its own `?? "ea"`.
11. `rfq_items.quantity` is `integer` — outside the model entirely.

### P3 — cleanup
12. `products.weight_unit` / `tare_weight` legacy columns.
13. `useWmsIdentityGate` invents the words `"each"`/`"unit"`.
14. POS archive / transfer / split-bill line tables drop provenance.

## 4. Business-event verdict

| Event | Works today? |
|---|---|
| A/B Buy + receive 10 × 50 kg bags → 500 kg | Yes, but conversion happens on the client (P0) |
| C Sell 17 kg → 483 kg | Model supports it; invoice render unverified |
| D Sell 50 kg as 1 × 50 kg Bag | Supported (packaging_id + display_quantity) |
| E POS sells 2 kg | Yes whole-number; **2.5 kg blocked** by hand |
| F Return 5 kg | Provenance-copy unverified |
| H Partial receipt 6 then 4 bags | Supported |
| I Multiple pack levels (10/25/50 kg) | Supported without duplicate SKUs |
| J Packaging changed after posting | **Weak** — `uom_snapshot` is free text (`"Bag × 50 KG"`), not a structured factor. Historical meaning is human-readable, not machine-recomputable |

## 5. Remediation plan (phased, converge — do not duplicate)

**Phase 0 — close the evidence gaps (no code changes).** Read
`_confirm_invoice_core`, the three POS commit functions, `create_sales_return_atomic`,
`_resolve_credit_note_line`, `create_delivery_note_atomic`, the 3-way-match
tolerance function, and locate the insert that populates
`goods_receipt_items.packaging_id`. Confirm which document surface rendered
`100 ea`. Deliverable: a confirmed pass/fail per flow appended here.

**Phase 1 — P0 database integrity.** Add a base-normalization trigger to
`purchase_order_items` (reusing `resolve_line_base_quantity`, not new maths),
and move receiving conversion server-side so the RPC takes
`(packaging_id, entered_qty)` and calls `wms_to_base_qty`. `toBase()` becomes
preview-only, enforced by an eslint rule.

**Phase 2 — historical immutability.** Replace decorative `uom_snapshot` text
with a structured snapshot (`packaging_name`, `factor`, `base_uom_code`) —
additive columns, backfilled from existing text, old column retained for
display until consumers migrate.

**Phase 3 — ledger provenance.** Add `display_quantity` + structured snapshot
to `stock_movements`; extend `enforce_line_uom_consistency` to it.

**Phase 4 — one formatter.** Make `formatQty.ts` the sole TS implementation;
`packagingRollup.ts`/`useQtyFormatter.ts` become thin re-exports. Add a
cross-runtime golden-case test asserting the Deno `formatQtyCell` and receipt
formatter produce byte-identical output for a fixed case table.

**Phase 5 — UI convergence.** Replace all 8 `unit_of_measure ?? "ea"` sites
with `baseUomLabel(product.base_uom)`. Where base UoM is genuinely missing,
render a "UoM not configured" data-integrity badge — **never** silently "ea".
Add an eslint rule banning `?? "ea"` outside `src/lib/inventory/`.

**Phase 6 — documents.** Wire `LINE_ITEM_UOM_SELECT` into `purchasesRequisition`,
`purchasesRfq`, `wmsReturn`; make `purchasesGrn` import `baseUomLabel`.

**Phase 7 — POS fractional entry.** Allow decimal quantity when the resolved
base UoM's category is non-count, using `units_of_measure.rounding` as the step.

**Phase 8 — packaging applicability + legacy cleanup.** Add explicit
`is_sellable`/`is_purchasable` flags; migrate `rfq_items.quantity` to numeric;
retire `weight_unit`/`tare_weight`.

## 6. Regression strategy

SQL guards (`supabase/tests/`): 10×50 kg → 500 kg; 500−17 → 483; 500−50 → 450;
mismatched `display_quantity`×factor rejected on every one of the 14 guarded
tables; kg→L rejected; base-UoM change blocked after a movement; partial
receipt 6+4; return of 5 kg reverses exactly 5 base units; posted invoice
snapshot unchanged after packaging edit.

TS tests: golden case table shared by all four formatters (count, weight,
volume 2.5 L, length 17.5 m, fractional 1.25 kg, pack 1×50 kg Bag, multi-pack
decomposition); a `?? "ea"` grep guard; POS cart accepts 2.5 for a weight
product and rejects 2.5 for a count product; snapshot tests asserting every
line-item document kind selects `LINE_ITEM_UOM_SELECT`.

Explicit non-goal: no new UoM table, packaging table, conversion engine, or
formatter. Every phase converges onto what already exists.
