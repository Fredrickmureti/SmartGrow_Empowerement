# Putaway Architecture Audit — Findings and Rebuild Plan

## What putaway actually is

Putaway is the *directed* transfer of custody from the receiving dock to a storage
position. It exists because receiving proves *what arrived*, not *where it lives*.
It is created by a receipt-class event (goods receipt, return disposition, QC
release, production output, cross-dock reject, count re-slot), performed by an
operator with equipment, and it decides the storage position under constraints
(product, batch/expiry, hazard, temperature, weight, volume, velocity, capacity).
When it completes, the bin becomes authoritative: picking, replenishment, counting,
slotting and availability all read from it.

## Current architecture (verified)

- `wms_tasks` is a real FSM with `row_version` optimistic locking, lease/claim
  (`wms_claim_next_task` with SKIP LOCKED, heartbeat, reaper), typed transitions
  (`wms_transition_task`), immutable `wms_task_events` ledger, outbox events.
- Tasks are seeded only by `receive_goods_to_wms` (called from
  `wms_post_receiving_session`): one LPN + one quant + one putaway task per
  goods-receipt line, staged at a receiving location.
- Destination comes from `suggest_putaway_locations`, which ranks candidates in
  exactly three hardcoded branches: same-product consolidation, same-category,
  general priority. Top suggestion is auto-chosen; top 3 stored in
  `wms_putaway_suggestions`.
- Completion is `complete_putaway_task(task_id)` → `wms_lpn_move`, which moves the
  plate, its quants and nested children, then flips the task to completed.
- Mobile `/wm` putaway screen scans the destination bin through `BinScanField`
  (`resolve_location_identity`), with an offline queue. Desktop board is a
  three-column Pending / In progress / Done-today card list.
- Topology columns exist on `stock_locations` (`structure_level`, `barcode`,
  `pick_sequence`, `putaway_priority`, `capacity_max_units`, `capacity_max_weight`,
  `is_putaway_target`, `is_receiving_staging`).

## Strengths

- Genuine task substrate: leases, optimistic locking, event ledger, outbox — most
  of the hard concurrency work is done and correct.
- Clean domain boundary: Inventory owns quants/cost; Warehouse orchestrates
  movement through `wms_lpn_move`. Putaway never writes cost.
- Identity-resolved bin scanning already exists (barcode ≠ code handled).
- Offline queue, exceptions tables, labour, telemetry and crossdock tables already
  exist as neighbours to integrate with.

## Weaknesses / missing enterprise capability

1. **No strategy engine.** `wms_slotting_rules` (velocity class, hazmat, temp
   control, max weight, target zone) is referenced *only by its own RLS policy* —
   nothing consults it. There is no fixed bin, empty bin, nearest bin, FEFO zone,
   hazmat, cold-chain, heavy-item, high-velocity, overflow, bulk or dynamic
   slotting strategy, and no per-warehouse strategy configuration or ordering.
2. **No validation engine.** `complete_putaway_task` checks only: task exists,
   business access, type, state, destination present, LPN present. It does **not**
   verify the scanned destination, SKU, lot, serial, quantity, capacity
   (`capacity_max_*` are never enforced), weight, hazard class, temperature zone,
   location status/lock, count freeze or QC hold. Bin proof is client-side only —
   the RPC can be called with no scan at all.
3. **No topology awareness.** Suggestions ignore `structure_level`, zone hierarchy,
   travel distance and `pick_sequence`; destination is effectively "some active
   putaway-eligible bin".
4. **Single-shot task grain.** No partial putaway, no split across bins, no
   over/short reconciliation, no multi-drop directed sequence, no LPN
   consolidation/deconsolidation during putaway.
5. **Lifecycle gaps.** `wms_task_state` carries legacy duplicates
   (`pending`/`available`, `done`/`completed`) and lacks explicit `blocked`
   /`escalated`; pause/resume exist in the enum but no UI path. Putaway can be
   completed straight from `pending` with no claim.
6. **Only one creator.** Returns, QC release, cross-dock reject, manufacturing and
   count re-slot do not create putaway tasks. Cross-dock is never consulted, so
   stock that should bypass storage is still directed to a bin.
7. **No prioritisation model.** Priority is a constant `100`; no dock congestion,
   perishability, hazard, reservation, wave demand, SLA or operator-proximity input.
8. **No supervisor visibility.** Three static columns; no aging, SLA breach,
   operator ownership, zone congestion, bin fill, blocked reason or receipt linkage.
9. **Weak exception path.** Failures surface as raw RPC error toasts; the existing
   `wms_exceptions` machinery is not wired to putaway (destination full, bin
   blocked, damage found, wrong lot, locked location).
10. **Labels.** Bin label printing exists via the document platform, but pallet /
    LPN / license-plate label reprint is not offered at the putaway step.

## Target architecture

```text
Receipt / Return / QC release / Crossdock reject / Count re-slot
        └─> putaway_request (source-agnostic intake)
              └─> STRATEGY ENGINE  (ordered, configurable rules)
                    fixed → consolidate → FEFO/temp/hazmat zone →
                    velocity slot → empty bin → nearest → overflow → bulk
                    with capacity/weight/volume feasibility filter
                    └─> directed task (dest + rank + reason trail)
                          └─> claim → travel → scan LPN → scan bin
                                └─> SERVER-SIDE VALIDATION GATE
                                      └─> wms_lpn_move (Inventory writes)
                                            └─> events, labour, telemetry
```

## Implementation phases

**Phase 1 — Strategy engine (DB).** New `wms_putaway_strategies` (per warehouse,
ordered, typed: fixed_bin, consolidate, empty_bin, nearest, fefo_zone, hazmat,
cold_chain, heavy, velocity, overflow, bulk, quarantine) plus
`wms_product_fixed_bins`. Rewrite `suggest_putaway_locations` into a
strategy-driven, capacity/weight/hazard/temperature-feasible ranker that consumes
`wms_slotting_rules` and location topology, returning `(location_id, rank, strategy,
reason, feasible_qty)`. Seed a sensible default strategy set per warehouse.

**Phase 2 — Validation + completion contract.** Replace
`complete_putaway_task(task_id)` with
`wms_complete_putaway(task_id, row_version, destination_scan, lpn_scan, quantity,
lot, serial, override_reason)`. Server resolves scans through
`resolve_location_identity`, enforces SKU/lot/serial/quantity/capacity/weight/
hazard/temp/location-status/count-freeze/QC-hold, requires claim, supports partial
and split putaway, and records every override with a reason on the event ledger.

**Phase 3 — Intake + prioritisation.** Source-agnostic task creation for returns
disposition, QC release, cross-dock reject, count re-slot; cross-dock check before
directing to storage; computed priority from perishability, hazard, dock
congestion, reservation/wave demand and SLA, with `sla_at` populated.

**Phase 4 — Exceptions.** Structured putaway exception reasons (destination full,
bin blocked, damaged, wrong lot/serial, location locked, count freeze, no barcode)
wired into `wms_exceptions` with recovery actions: re-slot to next suggestion, send
to overflow, quarantine, escalate to supervisor.

**Phase 5 — Operator surface (mobile, scan-first).** Rebuild `/wm` putaway as a
zero-thinking directed flow: next task → destination + travel hint → scan LPN →
scan bin → confirm qty → done; alternate-bin picker from ranked suggestions,
exception buttons, pallet/LPN label reprint, offline replay preserved.

**Phase 6 — Supervisor control tower (desktop).** Replace the three-column board
with an operational table + KPI strip: open/overdue/unassigned counts, aging and
SLA, operator ownership, zone congestion and bin fill, receipt/dock linkage,
blocking reason, bulk assign/reprioritise/release, live realtime updates.

**Phase 7 — Guards.** Architecture tests asserting: no direct `wms_tasks` UPDATE
from UI, strategy engine is the only destination source, completion RPC is the only
stock-move path for putaway, and every new state has an event topic.

## Technical notes

- All stock effects continue to flow through `wms_lpn_move`; Inventory stays the
  canonical owner of quantity and cost. No cost logic is added.
- Every new table gets GRANTs + RLS scoped to business access, per project convention.
- New state transitions emit `warehouse.*` outbox events with `wms.<entity>:<id>:<state>`
  idempotency keys, per ADR 0079.
- ADR 0079 gets a companion ADR documenting the putaway strategy contract.
