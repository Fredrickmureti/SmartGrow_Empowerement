# Milk simulation — Warehouse → Inventory business-event forensic report
Date: 2026-08-16 · Product: `E2E Milk 500ml Packet` (`a375087e…`, SKU `E2E-MILK-500`)
Scope: 200 cartons × 30 packets = 6,000 packets, per inbound leg.

## A. Actual implemented business-event flow

```
purchase_requisitions → rfqs/rfq_quotations/rfq_awards → purchase_orders (draft→submitted→approved)
    ↓ (approved PO is the authoritative inbound expectation)
inbound_shipments + inbound_shipment_items  (ASN, optional, FK to PO line)
    ↓
wms_dock_appointments / wms_trailer_visits / wms_gate_events  (optional, not gating)
    ↓
PATH 1  wms_receiving_sessions → wms_capture_receiving_line → wms_post_receiving_session
        → goods_receipts(draft) → complete_goods_receipt_atomic
PATH 2  receive_inbound_shipment(_shipment_id,…) → goods_receipts(draft)
        → complete_goods_receipt_atomic
    ↓ (single posting authority)
complete_goods_receipt_atomic
    ├─ wms_apply_gr_stock       → stock_movements (base units) → _maintain_stock_quants → stock_quants
    │                            → cost_layers (AVCO) → warehouse_stock / products.stock_quantity
    ├─ finance_post_gr_journal  → journal_entries (Dr Inventory / Cr GRNI)
    └─ business_event_outbox: procurement.gr.posted / goods_receipt.posted
    ↓
PATH 1 only: wms_license_plates + wms_tasks(putaway, pending) → putaway → location move
```

Classification of warehouse surfaces for this event: **required** — Receiving, Inbound tower (projection), Putaway, Handling units (path 1), Warehouses/Layout (config). **Conditional** — Appointments, Gate/Yard/Trailers, QC (only when a hold reason/hold flag applies). **Not applicable** — Cross-dock, Returns, Replenishment, Cycle counts, Slotting, Wave planning, Dispatch/Loading, 3PL billing, Labour, label printing.

## B. Event-by-event verification (live evidence)

| Event | Producer | State before → after | DB writer | Outbox topic | Inventory effect | Result |
|---|---|---|---|---|---|---|
| PO submitted/approved | procurement | draft→submitted→approved | PO RPCs | `procurement.po.submitted/approved` | none | PASS |
| ASN created / in transit / arrived | procurement | created→arrived | `inbound_shipments` + `_emit_asn_outbox` | `procurement.asn.*` | none (correct) | PASS |
| Receiving line captured | warehouse | – → captured | `wms_capture_receiving_line` (entered 200 × pack 30 → 6,000 base, server-side) | `warehouse.receiving.line_captured` | none | PASS |
| Session posted (path 1) | warehouse | captured→posted | `wms_post_receiving_session` → `complete_goods_receipt_atomic` | `warehouse.receiving.posted`, `procurement.gr.posted` | +6,000 (GRN-2026-00005, movement `6ae785df`) | PASS |
| ASN received (path 2) | procurement | arrived→received | `receive_inbound_shipment` → `complete_goods_receipt_atomic` | `procurement.grn.received`, `goods_receipt.posted` | +6,000 (GRN-2026-00006, movement `d1d41fe0`) | PASS |
| GR journal | finance | – → posted | `finance_post_gr_journal` | – | JE-00031 / JE-00032, Dr Inventory / Cr GRNI 7,999.998 each | PASS |
| Handling unit + putaway task | warehouse | – → pending | `receive_goods_to_wms` | `warehouse.receipt.staged` | plate-scoped quant, task `1930c2fc` | PASS (path 1 only) |

Outbox health after remediation: 31 events since 22:00, **0 failed, 0 pending, 0 dead letters**.

## C. Quantity reconciliation (200 × 30 = 6,000 per leg; 2 legs = 12,000)

| Source | Base qty | Display |
|---|---|---|
| purchase_order_items.quantity | 12,000 | 200 cartons/leg, `Carton (30) × 30 PCE` snapshot |
| inbound_shipment_items.expected_quantity | 6,000 (one ASN leg) | 200 |
| goods_receipt_items.quantity_received | 12,000 | – |
| stock_movements | 12,000 | 200 (factor 30) on the WMS leg |
| stock_quants | 12,000 | plate 200 / location 6,000 |
| warehouse_stock | 12,000 | – |
| products.stock_quantity | 12,000 | – |
| cost_layers | 2 × 6,000 @ 1.333333 (= 40.00/carton ÷ 30) | – |

Conversion happens exactly once, server-side, through `wms_to_base_qty` / `product_packaging.qty_in_base_uom`. No client-side conversion. No double conversion.

## D. Defects found and their disposition

| # | Class | Defect | Root cause | Status |
|---|---|---|---|---|
| P0-1 | Inventory integrity | Plate-scoped quant added without relieving the location-scoped one when staging = default location → double count | `receive_goods_to_wms` relocation was not a relieve+add pair | FIXED (`20260816230348`) |
| P0-2 | Lifecycle / financial | `receive_inbound_shipment` created a draft GRN, rolled up the PO and stopped — no movements, no GRNI journal, PO closed | ASN leg bypassed the posting authority | FIXED (`20260816230735`) — now routes through `complete_goods_receipt_atomic` |
| P0-3 | UOM integrity | `inbound_shipment_items.expected_quantity` accepted an unconverted pack figure (200) while the ledger is base units | no normalizer trigger, unlike `stock_movements` | FIXED (`20260816230853`) — expected = base, display = entered |
| P0-4 | Event lineage | 25 emitted topics unregistered in `business_event_topics`; `pos_topic_handler_scope` fell back to `server`, dispatcher dead-lettered them as `unknown_event_type` | prefix fallback with no completeness guard | FIXED (`20260816231127`, `…231313`, `…231424`) + dead letters replayed |
| P2-1 | Architecture | Two receipt entry paths converge on the same posting authority, but only path 1 creates a licence plate and a putaway task; ASN-direct receipts land in stock with no physical execution record | `receive_inbound_shipment` does not call `receive_goods_to_wms` | OPEN |
| P2-2 | Architecture | No DB invariant preventing a product balance being counted both plate-scoped and location-scoped at the same location | quants key allows both shapes | OPEN |
| P3-1 | Test hygiene | Simulation rows (`E2E-MILK-*`, `_e2e_milk_log`) are not tagged `is_sample_data` | sim script | OPEN |

## E. Architecture assessment

Warehouse and Inventory are **one coherent system at the posting boundary and event fabric**, not merely UI-adjacent:
- Inventory owns quantity/valuation (`stock_movements` → `stock_quants` → `cost_layers`); Warehouse owns physical execution (`wms_*`); Procurement owns commitment (`purchase_orders`).
- `complete_goods_receipt_atomic` is the single writer that turns a receipt into stock **and** the GRNI accrual; both entry paths now go through it, so stock cannot be created by an app path that skips accounting.
- Idempotency: GRN posting is guarded (`status = 'completed'` short-circuits), capture is replay-keyed (`client_scan_id`, `replayed:false/true`), outbox rows are keyed `procurement.gr:<id>:posted` / `inventory.movement.recorded:<movement_id>`.
- Auditability holds end to end: 6,000 packets → `stock_quants` → `stock_movements(reference_type=goods_receipt)` → `goods_receipts` → `purchase_order_items` → `purchase_orders` → supplier; the ASN leg additionally carries `inbound_shipment_items.purchase_order_item_id`.

The remaining weakness is **physical-execution coverage, not integrity**: an ASN-direct receipt is financially and quantitatively correct but leaves no plate and no putaway task (P2-1).

## F. Remediation plan (dependency order)

1. **P2-1** — make `receive_inbound_shipment` call `receive_goods_to_wms` (staging location from the shipment's dock/warehouse default) so every receipt, regardless of entry path, produces the same plate + putaway task. Pin with a pgTAP test asserting `wms_tasks(putaway)` exists for every completed `goods_receipts` row.
2. **P2-2** — add a DB invariant (partial unique / check trigger) that a `(product, location, lot)` balance is either plate-scoped or location-scoped, never both; extend `check_stock_quant_drift()` to report the mixed shape.
3. **P0-4 guard** — add an architecture test that fails when any topic literal emitted by a trigger/RPC is missing from `business_event_topics` (prevents a third recurrence).
4. **P3-1** — teardown migration for the `E2E-MILK-*` fixtures and `_e2e_milk_log`.
