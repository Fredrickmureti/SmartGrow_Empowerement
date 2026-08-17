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
| P2-1 | Architecture | Two receipt entry paths converge on the same posting authority, but only path 1 creates a licence plate and a putaway task; ASN-direct receipts land in stock with no physical execution record | `receive_inbound_shipment` does not call `receive_goods_to_wms` | FIXED (2026-08-17) — ASN path now stages via `wms_resolve_receiving_staging_location` + `receive_goods_to_wms` (idempotent per receipt line); pinned by `supabase/tests/receipt_paths_physical_execution_parity_test.sql` |
| P2-2 | Architecture | No DB invariant preventing a product balance being counted both plate-scoped and location-scoped at the same location | quants key allows both shapes | FIXED (2026-08-17) — writer invariant: `receive_goods_to_wms` raises `WMS_STAGING_UNRELIEVED_BALANCE` when no loose quant is relieved, so a plate quant can never be additive; `check_stock_quant_drift()` now reports the `stock_quants.mixed_scope` shape. A blanket table constraint was deliberately NOT added: loose + plate stock in one storage bin is legitimate; only an unrelieved staging write is a defect |
| P0-4b | Event lineage | Recurrence: 9 further topics (`purchase_return.*`, `purchasing.purchase_return.*`, `procurement.grn.received`, `warehouse.receiving.discrepant/closed`) plus 14 emitted-but-never-fired warehouse topics were unregistered; 6 events dead-lettered | the dispatcher's hardcoded handler map and `business_event_topics` were two independent registries | FIXED (2026-08-17) — all 23 topics registered; `outbox-dispatcher` now treats any registry-known server topic without a bespoke handler as record-only, so the two registries can no longer diverge; the 6 dead letters were replayed and succeeded (outbox: 215 succeeded, 0 failed, 0 dead) |
| P3-1 | Test hygiene | Simulation rows (`E2E-MILK-*`, `_e2e_milk_log`) are not tagged `is_sample_data` | sim script | FIXED (2026-08-17) — product, both POs and their stock movements tagged `is_sample_data = true`. Rows are retained, not deleted: the receipts carry posted journals and are the evidence base for this report |

## E. Architecture assessment

Warehouse and Inventory are **one coherent system at the posting boundary and event fabric**, not merely UI-adjacent:
- Inventory owns quantity/valuation (`stock_movements` → `stock_quants` → `cost_layers`); Warehouse owns physical execution (`wms_*`); Procurement owns commitment (`purchase_orders`).
- `complete_goods_receipt_atomic` is the single writer that turns a receipt into stock **and** the GRNI accrual; both entry paths now go through it, so stock cannot be created by an app path that skips accounting.
- Idempotency: GRN posting is guarded (`status = 'completed'` short-circuits), capture is replay-keyed (`client_scan_id`, `replayed:false/true`), outbox rows are keyed `procurement.gr:<id>:posted` / `inventory.movement.recorded:<movement_id>`.
- Auditability holds end to end: 6,000 packets → `stock_quants` → `stock_movements(reference_type=goods_receipt)` → `goods_receipts` → `purchase_order_items` → `purchase_orders` → supplier; the ASN leg additionally carries `inbound_shipment_items.purchase_order_item_id`.

The remaining weakness identified here — **physical-execution coverage, not integrity** — is now closed: both receipt paths produce identical plate + putaway records, and staging can no longer create stock it did not relieve.

## F. Remediation plan (dependency order)

All four steps are executed (2026-08-17):

1. **P2-1 — done.** `receive_inbound_shipment` stages through the shared staging resolver and `receive_goods_to_wms`. Guard: `supabase/tests/receipt_paths_physical_execution_parity_test.sql` (structural + behavioural: no completed receipt line without a putaway task).
2. **P2-2 — done (writer invariant + audit visibility).** See the defect table for why a blanket table constraint was rejected.
3. **P0-4 guard — done.** `supabase/tests/business_event_topic_registration_test.sql` now also scans emitter source for topic literals, so an unregistered topic fails the test *before* it ever fires. The dispatcher reads the registry as the single source of truth.
4. **P3-1 — done.** Simulation rows tagged `is_sample_data`; `_e2e_milk_log` retained as the simulation audit trail.

## G. Live UI-driven re-run (2026-08-17) — receiving board worked to empty

The report above was written from the ASN-direct leg. Running the **operator path**
(receiving workspace → putaway queue) on a fresh PO exposed two defects that the
ASN leg could never have surfaced, because it never touched the suggestion engine.

### Defects found by the operator-path run

| # | Class | Defect | Root cause | Status |
|---|---|---|---|---|
| P0-5 | Broken code path | Every `wms_post_receiving_session` aborted (42883). Sessions stranded in `unloading`/`captured`; the board showed work that could not advance | `receive_goods_to_wms` called `wms_suggest_putaway_location(...)` — a function that has never existed — and inserted `wms_putaway_suggestions.warehouse_id` / `.strategy_id`, columns that do not exist | FIXED — now calls the canonical `suggest_putaway_locations`, writing only real columns |
| P0-6 | Executability | Putaway tasks were created with `destination_location_id = NULL`, or with a bin that `complete_putaway_task` then rejected as `partial_capacity` — an instruction the operator cannot execute | (a) Nakuru Depot had exactly one location (`NKR-DEFAULT`, a staging area) and therefore no valid putaway target; (b) `suggest_putaway_locations` ranked purely by strategy sequence, so a bin with room for 2,000 of a 2,940 pallet outranked an empty bin | FIXED — rack zone + bins `NKR-A-01…04` seeded; ranking now puts full-fit bins ahead of partial-fit ones |

Both are pinned by `supabase/tests/putaway_suggestion_contract_test.sql`
(no call to the phantom function, no phantom columns, full-fit ranking, and a
behavioural check that no open putaway task has a NULL destination).

### Event-by-event trace of the operator run (PO 100 cartons, deliberate 2-carton short)

| # | Event | Mechanism | Result |
|---|---|---|---|
| 1 | PO issued, 100 cartons | `purchase_orders` | ok |
| 2 | ASN created, appointment scheduled | `create_inbound_shipment`, `schedule_dock_appointment` (`p_type='inbound'`) | ok |
| 3 | Shipment arrived / yard | `mark_inbound_shipment_arrived` | ok |
| 4 | Session `open → unloading` | `wms_transition_receiving` | ok |
| 5 | Lines captured 98/100 cartons | `wms_capture_receiving_line` (entered 98 + packaging → 2,940 base) | ok, conversion server-side |
| 6 | Variance flagged | `wms_flag_receiving_variances` | 2 exceptions raised (`under_receipt`, `receiving_discrepancy`) |
| 7 | Session posted | `wms_post_receiving_session` → `complete_goods_receipt_atomic` | GRN-2026-00007, stock + GRNI journal — **previously failed here** |
| 8 | Plate staged, putaway task raised | `receive_goods_to_wms` | LPN + task, destination suggested |
| 9 | Putaway completed | `complete_putaway_task` | 2,940 → `NKR-A-02`; the earlier 6,000 plate → `NKR-A-01` |
| 10 | Session closed | `wms_transition_receiving` | board empty |

### Final reconciliation

| Ledger | Milk (packets) |
|---|---|
| `stock_movements` net | 14,940 |
| `products.stock_quantity` | 14,940 |
| `stock_quants` | 6,000 loose `NKR-DEFAULT` + 6,000 plate `NKR-A-01` + 2,940 plate `NKR-A-02` |

14,940 = 12,000 (two 200-carton legs × 30) + 2,940 (98 cartons × 30). Every leg
converts once. **Open receiving sessions: 0. Open putaway tasks: 0.**

### Assessment update

The integrity layer held throughout — no phantom stock, no double count, no
unbalanced journal. What failed was the **execution layer**: a call to a function
that does not exist, and a suggestion engine that emitted instructions the
completion RPC would refuse. Neither is detectable from the data model; both need
the operator path to be exercised, which is exactly why this re-run was required.
