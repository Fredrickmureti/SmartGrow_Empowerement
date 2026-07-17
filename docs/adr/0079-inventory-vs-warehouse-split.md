# ADR 0079 — Inventory vs Warehouse split

Status: Accepted (2026-07-17)
Supersedes: nothing. Complements ADR 0064 (locations/quants), ADR 0068 (transfers), ADR 0076 (stock event fabric), ADR 0078 (AVCO).

## Context

The historical `/inventory-app/warehouses` surface treated a warehouse as a
CRUD record (name, address, manager). Inventory Foundation work through
ADR 0078 delivered an enterprise-grade **ledger**: quants, movements, lots,
serials, event fabric, landed cost, 3-way match.

What we still lacked was an enterprise-grade **execution layer**: a home
for the physical, human, and time-bounded operations that happen inside a
warehouse — appointments, docks, put-away, waves, picks, packs, loads,
LPNs, operator tasks. Bolting those onto Inventory would blur the
boundary between "what/how much we own" (Inventory) and "where it is
physically, who's moving it, which task is next" (Warehouse).

## Decision

Split responsibilities across two distinct workspaces:

| Concern | Home | Canonical tables |
|---|---|---|
| Stock quantity, ownership, valuation, cost | **Inventory** (`/inventory-app/*`) | `stock_movements`, `stock_quants`, `stock_lots`, `stock_serials`, `cost_layers`, `warehouse_stock*` |
| Physical location hierarchy | Shared (owned by Inventory schema; authored via Warehouse UI) | `stock_locations` (extended with `structure_level`, `barcode`, `pick_sequence`, capacity fields) |
| Physical execution — LPN, task, appointment, dock, wave, manifest, QC | **Warehouse** (`/warehouse-app/*`) | `wms_license_plates`, `wms_tasks`, and Phase 2+ tables (`warehouse_docks`, `receiving_appointments`, `pick_waves`, `pack_stations`, `shipment_packages`, `loading_manifests`, `qc_inspections`) |

Inventory remains the single source of truth for quantity and value.
Warehouse **never** owns cost or quantity — it emits business events onto
the existing `business_event_outbox` (ADR 0076), and Inventory writers
consume the resulting operations.

## Consequences

1. `/inventory-app/warehouses/*` becomes a redirect into
   `/warehouse-app/warehouses/*`. Deep links preserved.
2. All physical-workflow tables live under the `wms_*` namespace so future
   audits can find the boundary by name alone.
3. Every WMS state transition publishes a `warehouse.*` event onto
   `business_event_outbox` with an idempotency key of the form
   `wms.<entity>:<id>:<state>` — same shape as `stock.movement:<id>`.
4. Inventory writers are not modified in Phase 1. Later phases add
   put-away/pick tasks that stamp `source_location_id` and
   `destination_location_id` on `stock_movements`, migrating quants off
   the per-warehouse default bin without a schema change.

## Phased delivery

See `.lovable/plan.md`. Phase 0 delivered scaffolding + layout editor.
Phase 1 (this ADR) delivers LPN + universal task substrate. Phases 2–7
add Receiving, Put-away, Picking/Packing, Loading/Dispatch, QC, and
Operator productivity respectively.

## Non-goals

- No rework of Inventory-owned tables.
- No new cost/valuation logic.
- No changes to POS, Finance, or Localization.
