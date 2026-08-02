# Warehouse Returns (RMA) — Architecture Audit & Enterprise Rebuild

## 1. What exists today (verified)

**Data model**
- `wms_return_orders` — header only: `code`, `rma_reference`, `source_doc_type/id`, `customer_id`, `vendor_id`, `state`, `expected_at`, `received_at`, `closed_at`, `row_version`. No dock, no appointment, no carrier/parcel, no disposition summary, no credit-note link.
- `wms_return_lines` — **exists and is fully unreferenced by application code**: `product_id`, `lpn_id`, `lot_number`, `serial_number`, `expected_qty`, `received_qty`, `disposition`, `qc_inspection_id`, `destination_location_id`. No condition code, no inspection result, no photo, no `row_version`.
- `wms_return_state` enum: `draft → authorized → in_transit → received → inspecting → disposed → closed | cancelled`.
- `wms_transition_return(...)` — correct FSM: `FOR UPDATE`, `row_version` optimistic check, legal-edge table, emits to `business_event_outbox`. It does **nothing else**: no line validation, no stock movement, no disposition persistence, no task fan-out, no exception raise.

**UI**
- One file: `src/pages/warehouse/ReturnOrders.tsx` (346 lines). A filtered table + a "New return" dialog + a disposition `Select`. There is no `src/features/warehouse/returns/` module at all.
- Disposition is captured in the transition **payload only** and written to the outbox `extra` — it never lands on `wms_return_lines.disposition`, so it is not queryable, reportable, or auditable per line.

**Integration seams that exist in the platform but are NOT used by Returns**
| Seam | Available | Used by Returns |
|---|---|---|
| Identity/scan gate `useWmsIdentityGate` | yes | no |
| Label printing `printWmsLabel` (incl. `QUARANTINE`, `QUALITY_HOLD`, `PUTAWAY`, `LPN`) | yes | no |
| `wms_qc_inspections` + `wms_qc_inspection_checks` (has `photo_url`) | yes | no |
| `wms_tasks` polymorphic task engine + claim/lease RPCs | yes | no |
| `wms_exceptions` inbox | yes | no |
| `wms_license_plates` + `useLpnOps` | yes | no |
| `wms_dock_appointments`, `wms_trailer_visits` | yes | no |
| `stock_movements` (Inventory authority) | yes | no |
| `lot_quarantine` | yes | no |
| Document platform (`document_artifacts`, templates) | yes | no |
| `sales_returns` / `purchase_returns` (finance + credit note) | yes | **no link column** |

**Event drift (real bug):** `topics.ts` declares `warehouse.return.opened|inspected|dispositioned|closed`, but the RPC emits `'warehouse.return.' || state`, i.e. `authorized`, `in_transit`, `received`, `inspecting`, `disposed`. Three of the four declared topics are never emitted; five emitted topics are undeclared.

## 2. Assessment

Strengths: the FSM/optimistic-concurrency/outbox substrate is correct and matches ADR 0101; the receiving subsystem (`wms_receiving_sessions` + `wms_receiving_lines` + `wms_capture_receiving_line` + `ReceivingSessionWorkspace`) is a proven, in-repo template for exactly the workflow Returns is missing.

Weaknesses: Returns is a header-state CRUD page bolted onto an enterprise substrate. Physically, returned goods never move — no unload, no scan, no identity verification, no condition inspection, no location, no LPN, no label, no stock posting, no finance handoff. Disposition is a word in a JSON blob. Against SAP EWM / Manhattan / D365 SCM practice the missing layer is the entire **execution and disposition** half of the lifecycle.

## 3. Target architecture

```text
RMA authorization (customer | vendor | internal | transfer)
   ↓  expected return + carrier/parcel + dock appointment
Arrival → dock assign → unload session
   ↓  scan gate (identity + level + lot/serial/LPN)  ← useWmsIdentityGate
Line capture on wms_return_lines (qty, lot, serial, LPN, condition)
   ↓
Inspection → wms_qc_inspections + checks (+ photos)
   ↓
Disposition per line: return_to_stock | quarantine | scrap | vendor_return | repair | refurbish | quality_hold
   ↓  each disposition = its own destination location + its own task + its own label
Inventory posting (stock_movements only; Inventory stays the stock authority)
   ↓
Finance handoff → sales_returns / purchase_returns → credit note
   ↓
Documents via document platform → close
```
Boundaries kept: Warehouse owns execution and emits `warehouse.return.*`; Inventory owns quantity/valuation; Finance owns credit notes; the document platform owns every printed artifact; the hardware abstraction owns every scanner/printer/camera call.

## 4. Phased delivery

**Phase 0 — Event catalog repair (no behaviour change)**
Align `topics.ts` and `wms_events_catalog` with the topics the RPC actually emits; add the disposition/inspection topics the new flow needs. Guard test asserts SQL catalog ≡ TS catalog.

**Phase 1 — Domain model completion (migration)**
- Extend `wms_return_orders`: `return_kind` (customer/vendor/internal/transfer), `appointment_id`, `dock_id`, `trailer_visit_id`, `carrier_id`, `tracking_reference`, `finance_doc_type/id`, `credit_note_id`, `disposition_summary jsonb`.
- Extend `wms_return_lines`: `condition_code` (unopened/opened/damaged/defective/expired/missing_accessories/incorrect_item), `inspection_state`, `captured_by/at`, `restock_qty`, `scrap_qty`, `quarantine_qty`, `lpn_out_id`, `row_version`, `photo_count`.
- New: `wms_return_photos` (line-scoped, storage-backed), `wms_return_disposition_rules` (declarative default disposition by condition/product/customer).
- Grants + RLS on every new table, mirroring `wms_receiving_lines`.

**Phase 2 — Server-side operations (SECURITY DEFINER RPCs)**
`wms_capture_return_line` (scan-driven, idempotent), `wms_inspect_return_line` (creates/links `wms_qc_inspections` + checks), `wms_disposition_return_line` (rule-defaulted, validates destination location usage), `wms_post_return_dispositions` (writes `stock_movements` for restock/quarantine/scrap, quarantines lots, spawns putaway/scrap/vendor-return `wms_tasks`, raises `wms_exceptions` on blocked lines), `wms_close_return` (guards: every line dispositioned + posted + finance doc linked). Extend `wms_transition_return` guards to depend on line state rather than operator intent alone.

**Phase 3 — Returns feature module (`src/features/warehouse/returns/`)**
Hooks per aggregate (`useReturnOrders`, `useReturnLines`, `useReturnInspection`, `useReturnDisposition`, `useReturnPhotos`), no business logic in pages, thin page shells only. Mirrors the receiving module layout.

**Phase 4 — Returns operations console**
Replace the single table with:
- **Returns tower** — swimlanes by lifecycle stage (Expected / At dock / Unloading / Awaiting inspection / Blocked / Awaiting disposition / Awaiting posting / Awaiting finance / Awaiting print), realtime via `useWmsRealtimeSync`, counts + aging.
- **Return session workspace** — split-pane: scan field + line grid + inspection panel + disposition panel + LPN/label rail + event timeline (`OutboxTimeline`/`ActivitySection`).
- **Inspection workspace** — per-line checks, condition, photo capture, pass/fail/conditional.
- **Mobile operator surface** — handheld/phone-first capture route reusing the existing scan-intent + `ScanStatusChip` feedback path.
Built on the existing design system + shadcn primitives (`Resizable`, `Tabs`, `Command`, `Table`) and the WMS dashboard primitives already in `src/features/warehouse/dashboards`, so no divergent UI stack is introduced.

**Phase 5 — Hardware integration**
Scanners/handhelds via the existing scan-intent bus and identity gate (blocking on unknown/ambiguous). Camera capture through a single `ReturnPhotoCapture` component writing to storage + `wms_return_photos`. Labels exclusively via `printWmsLabel` — `QUARANTINE`, `QUALITY_HOLD`, `PUTAWAY`, `LPN`, plus new `wms.label.return_receipt` / `wms.label.disposition` template keys seeded in SQL. No printer or device code inside Returns.

**Phase 6 — Document + finance integration**
RMA authorization, return receipt, inspection report, damage report, vendor return note generated through the document platform (`document_artifacts` + templates), never ad hoc. Finance handoff links `wms_return_orders` to `sales_returns`/`purchase_returns` and the resulting credit note; posting stays in Finance.

**Phase 7 — Guard tests & docs**
Architecture tests: no direct `.update({ state })` on returns tables; no direct `product_identifiers` query from returns; no `printLabel`/printer import outside the label seam; catalog parity; disposition must be persisted on the line, not only in the outbox. New ADR documenting the Returns execution model.

## 5. Technical notes

- No new stock-writing path: all inventory effects go through `stock_movements` inserts inside the disposition-posting RPC, so ADR 0076's event fabric and ADR 0078 AVCO keep working unchanged.
- Every new state writer is an RPC with `p_row_version`; direct state UPDATEs stay forbidden.
- Migrations are additive; the existing header FSM and its outbox keys are preserved so in-flight returns are unaffected.
- Each phase ships independently and leaves `/warehouse-app/returns` functional.
