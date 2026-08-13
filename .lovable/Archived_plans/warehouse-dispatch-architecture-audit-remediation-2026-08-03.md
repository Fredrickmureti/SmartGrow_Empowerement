# Warehouse Dispatch — Architecture Audit & Remediation

## What Dispatch is

Dispatch is the **outbound custody-transfer orchestrator**. It is not inventory
deduction, not shipping, not order completion. It owns exactly one question:
*has this physical handling unit legally and physically left our building, on
whose truck, verified by whom, with what evidence?*

It orchestrates; it must not own stock balances (Inventory owns those), pick/pack
execution (Warehouse owns that), or revenue (Finance owns that). What it does own:
manifest, load verification, carrier assignment, seal, driver acknowledgement,
departure timestamp, proof of dispatch, tracking identity.

## Audit verdict

The foundation is genuinely good and better than the brief assumes. `wms_loading_manifests`
has a real FSM (`wms_transition_manifest`, `draft→loading→closed→dispatched|cancelled`) with
`row_version` optimistic locking, server-enforced scan-out completeness (`WMS_SCAN_SHORTAGE`),
RPC-only writes pinned by architecture tests, an event catalog on `business_event_outbox`,
dock appointments with a GiST no-overlap constraint, yard/trailer lifecycle, LPN handling
units, and a scan-first Loading Bay plus a mobile dispatch screen.

Five real defects sit on top of it.

### 1. Goods leave the building without leaving the books — CRITICAL

Verified against the live database: none of `complete_pick_task`, `seal_pack_carton`,
`load_carton_onto_manifest`, `close_loading_manifest`, `dispatch_loading_manifest` or
`wms_transition_manifest` reference `stock_movements` or `stock_quants`. Dispatching a
manifest only flips `wms_license_plates.status = 'shipped'`.

The one ledger-correct outbound primitive — `wms_lpn_dispatch`, which posts `transfer_out`
movements and clears the quants — exists and is **called by nothing on the manifest path**.
Stock is relieved only by `complete_delivery_atomic` on the unrelated sales delivery-note
stack. A warehouse that dispatches through the Loading Bay reports stock it no longer has.

### 2. Two disconnected outbound stacks

`delivery_notes` (carrier, tracking number, `delivery_proofs`, stock relief, customer
notification SMS) and `wms_loading_manifests` (waves, cartons, LPNs, docks, yard, scan-out)
share only the `carriers` picklist. There is no `delivery_note_id` on manifests, no
`manifest_id` on delivery notes, and no event bridging them. Sales sees a dispatched DN with
no cartons; the warehouse sees a dispatched manifest no customer was ever told about.

### 3. No proof of dispatch at the manifest

Dispatch records `dispatched_at` and `dispatched_by` only. No seal number, no driver
acknowledgement, no signature, no photo. `delivery_proofs` and `SignatureCanvas` both exist
and are unwired from every warehouse page. Trailer `seal_in`/`seal_out` live on
`wms_trailer_visits` and are not linked to the manifest being dispatched.

### 4. Carrier is a contact row, not a capability

`carriers` = name, phone, email, `tracking_url_template`, `is_active`. No service levels, no
booking, no tracking-number allocation, no carrier-agnostic adapter contract. Manifests carry
no tracking number at all.

### 5. Live-ness and legacy drift

- `LoadingBay` queries `["wms-manifest", id]`; `useWmsRealtimeSync` publishes
  `["wms-loading-manifest"]`. Key drift means the bay is not realtime — it polls
  short-cartons every 15s.
- `wms_trailer_visits` and `wms_yard_slots` are not in `supabase_realtime`; YardBoard polls.
- Two `open_loading_manifest` overloads exist; `dispatch_loading_manifest` and
  `wms_transition_manifest` both mutate state with duplicated shortage enforcement.
- Documents: only `shipping_label` is wired. No bill of lading, dispatch manifest, packing
  list or carrier label.

## Target architecture

```text
Sales Order ─▶ Wave ─▶ Pick ─▶ Pack (carton = LPN) ─▶ Stage
                                                        │
                              ┌─── Dispatch orchestration ───┐
                              │  manifest + dock + trailer   │
                              │  scan-out verification       │
                              │  seal + driver ack + POD     │
                              └──────────────┬───────────────┘
                                             │ one atomic release
              ┌──────────────────────────────┼──────────────────────────────┐
              ▼                              ▼                              ▼
   Inventory: wms_lpn_dispatch      Sales: delivery note        Outbox: warehouse.
   posts transfer_out, clears       → dispatched/in_transit     manifest.dispatched
   quants (single stock authority)  + tracking number           → notify, finance, analytics
```

Dispatch calls into Inventory and Sales; it never re-implements them.

## Plan

**Phase A — ledger correctness (blocking, ship first).**
Make `wms_transition_manifest(... 'dispatched')` call `wms_lpn_dispatch` for every loaded
carton's LPN inside the same transaction, so departure posts `transfer_out` movements and
clears quants exactly once. Make it idempotent against already-`shipped` plates. Drop the
legacy `dispatch_loading_manifest`/`close_loading_manifest` wrappers and the stale
`open_loading_manifest` overload, and repoint `LoadingBay` + `MobileDispatch` at the FSM.
Add pgTAP invariants: dispatch relieves stock, double-dispatch is a no-op, cancel-after-load
restores nothing that was never deducted.

**Phase B — one outbound spine.**
Add `delivery_note_id` to `wms_loading_manifests` (resolved from the cartons' sales orders)
and `manifest_id` to `delivery_notes`. On manifest dispatch, transition the linked delivery
note to `dispatched` through the existing sales RPC rather than a second write path — which
also fires the existing customer-notification trigger. Guard with a constraint test that no
carton may join a manifest bound to a different customer.

**Phase C — proof of dispatch.**
New `wms_dispatch_proofs` (manifest_id, seal_number, driver_name, driver_id_ref,
signature_url, photo_urls[], captured_at/by, gps). Reuse the existing private
`delivery-proofs` storage bucket and `SignatureCanvas`. Capture step becomes mandatory in the
`closed → dispatched` edge when the business setting requires it; optional otherwise. Wire it
into `LoadingBay` and `MobileDispatch` (handheld-first: seal scan, signature, camera).

**Phase D — carrier abstraction.**
Extend `carriers` with `carrier_kind` (own_fleet / courier / 3PL / freight / parcel) and a
`carrier_services` child table (service level, transit days, tracking-number format). Add
`tracking_number` + `tracking_url` to manifests, allocated server-side by
`wms_allocate_tracking_number`. Keep it adapter-shaped so a live carrier API is a later
plug-in, not a rewrite.

**Phase E — dispatch documents.**
Register `bill_of_lading`, `dispatch_manifest`, `packing_list` and `carrier_label` fetchers in
`generate-document`, following the Phase-D cycle-count precedent. Dispatch *requests*
documents from the Enterprise Document Platform; it never renders them. Add coverage-matrix
rows and a wiring guard test.

**Phase F — control tower + live-ness.**
Fix the realtime key drift (align `LoadingBay` keys with `TABLE_INVALIDATIONS`), add
`wms_trailer_visits`/`wms_yard_slots` to the realtime publication, delete the two 15s polls.
Rebuild `OutboundDashboard` as the dispatch control tower: what is late, blocked, short-scanned,
awaiting seal, which dock is free, which truck is waiting — one screen, drill-down only.
Dock schedule and yard get a proper timeline view.

**Library position:** the project already has TanStack Table + Virtual and Recharts, which
cover the grid, the virtualized queue and the analytics. I recommend adding **nothing** in
Phases A–E. Revisit a timeline/Gantt library only at Phase F for dock scheduling, where the
hand-rolled view is genuinely weak — and only then.

## Technical notes

- All schema work goes through the migration tool; every state mutation stays inside a
  `SECURITY DEFINER` RPC with `row_version` optimistic locking, per ADR 0101.
- New ADRs, kept short: *Dispatch relieves inventory* (Phase A) and *Manifest ↔ delivery note
  as one outbound spine* (Phase B). No other new documentation.
- Every phase lands with architecture tests in `src/test/architecture/` and pgTAP invariants
  in `supabase/tests/`, matching the existing WMS convention.

Phase A is the only phase that fixes a correctness bug; B–F are capability. I suggest
approving A–C now and re-scoping D–F once A is in production.
