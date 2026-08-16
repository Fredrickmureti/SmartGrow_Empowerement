# Warehouse → Inventory milk simulation: verified status and fix plan

## What I re-verified this turn (live SQL, not inherited claims)

| Claim from previous pass | Verdict | Evidence |
|---|---|---|
| P0-1 stock double-count | CONFIRMED, root cause corrected | `stock_quants` holds two rows for milk product `a375087e…` at the same location: one location-scoped `6000` (lpn_id NULL) and one plate-scoped `6000` (lpn_id `1b3337e0…`, package_id set) = 12,000 for a physical 6,000 |
| Cause = conflict key omits `lpn_id` | WRONG | The upsert key in `_maintain_stock_quants` *does* include `COALESCE(lpn_id, …)`. The real cause is **two independent quant writers for one physical receipt** (see below) |
| P0-2 ASN path skips GRN completion | CONFIRMED | `receive_inbound_shipment(_shipment_id, _lines, _actor, _receipt_number, _receipt_date)` body contains no call to `complete_goods_receipt_atomic` |
| GRN posting is a synchronous accrual | CONFIRMED | `complete_goods_receipt_atomic` calls `wms_apply_gr_stock` then `finance_post_gr_journal`, flips status, emits `procurement.gr.posted` with idempotency key `procurement.gr:<id>:posted` |
| P0-3 no UOM normalizer on `inbound_shipment_items` | CONFIRMED | Only two triggers on that table: `_set_updated_at` and `_validate_inbound_shipment_item`. `stock_movements` by contrast has `_stamp_ledger_uom_snapshot`, `_enforce_movement_uom_granularity`, `_backfill_movement_packaging` |
| P0-4 unregistered topics dead-letter | CONFIRMED and **wider than reported** | `business_event_topics` registers `inventory.*` (server) and five `stock.*` (host) only. Dead letters in the last 7 days with `posting.contract_violation: unknown_event_type`: `warehouse.receiving.captured/line_captured/unloading/posted`, `warehouse.exception.raised/escalated`, `goods_receipt.posted`, `procurement.gr.posted`, `procurement.asn.created`, `procurement.po.approved`, `product.created`, `delivery_note.dispatched/completed`, `pos.payment.session.committed` |
| Ledger integrity | HOLDS | Exactly one `stock_movements` row for the milk product: `receipt`, qty `6000`, `reference_type = goods_receipt`. Carton→packet conversion (200 × 30) happened once, server-side |

## Corrected root cause for P0-1

`_maintain_stock_quants` (AFTER INSERT on `stock_movements`) explicitly early-returns for
`reference_type = 'wms_lpn'`, because "LPN operations relocate plate-scoped quants themselves".
The WMS receiving capture path writes the plate-scoped quant directly (one of
`receive_goods_to_wms` / `wms_lpn_*`), while the GRN posting path writes a movement whose
trigger creates the location-scoped quant. Neither writer knows about the other, so a single
physical receipt lands twice under two different key shapes. `warehouse_stock`,
`warehouse_stock_lots` and `products.stock_quantity` then inherit the error;
`check_stock_quant_drift()` audits *against* `stock_quants`, so it cannot detect this.

## Fix order

1. **P0-1 — one quant per physical receipt.** Decide the single owner of the plate-scoped
   quant, and make the LPN receive path and the GRN movement path mutually exclusive
   (either LPN quants carry the balance and the GRN movement stays audit-only for
   plate-bound receipts, or GRN owns the balance and LPN rows become containment metadata
   with zero quantity). Add a DB-level invariant that a product's balance at a location
   cannot be counted both plate-scoped and location-scoped, plus a pgTAP pin.
2. **P0-2 — ASN receipt reaches the posting path.** Route `receive_inbound_shipment`
   through `complete_goods_receipt_atomic` so stock movements *and* the
   Dr Inventory / Cr GRNI journal both fire; fix the shipment-id argument error.
   Today the ASN leg closes the PO with no movements and no accrual.
3. **P0-3 — UOM normalizer trigger on `inbound_shipment_items`,** mirroring the
   `stock_movements` stamping triggers so ASN lines cannot carry an unconverted pack qty.
4. **P0-4 — complete the topic registry.** Register every emitted topic listed above with
   the correct `handler_scope`, following migration `20260814160641` (the same defect class,
   patched once for `stock.*`). Then add a guard test that fails when a topic is emitted by
   any trigger/RPC but absent from `business_event_topics`, so this cannot recur a third time.
5. **Re-run the ASN leg end to end** and reconcile 200 cartons × 30 = 6,000 packets across
   `stock_movements`, `stock_quants`, `warehouse_stock`, `products.stock_quantity` and the GL.
6. **Teardown migration** for the simulation rows tagged `E2E-MILK-*` / `E2E-RCV-*` plus
   `_e2e_milk_log`.

## Technical notes

- All fixes are migrations against existing canonical mechanisms; no new engine, no parallel
  quant table, no client-side conversion.
- Each step lands with its own pgTAP or architecture test before moving to the next.
- No remediation is applied until you approve this order — P0-1 changes how balances are
  written, so it must settle before the ASN leg is re-run.
