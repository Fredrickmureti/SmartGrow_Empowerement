# Outbound Control Tower — architecture audit and rebuild

## What an Outbound Control Tower is

It is not dispatch, wave planning or packing. It is the surface that continuously
answers, for the whole outbound chain, three questions: *is outbound healthy right
now*, *which shipments will miss their departure*, and *what do I do about it*.
Its unit of interest is the **shipment/load moving through a lifecycle**
(order released → wave → pick → pack/carton → manifest → dock → trailer → sealed →
dispatched → proof), not a table of counts.

## Audit findings (verified against the codebase and database)

Strengths already in the platform — the rebuild consumes these rather than
re-inventing them:

- A real server-side health contract exists: `wms_flow_health`,
  `wms_flow_bottlenecks`, `wms_zone_load` RPCs plus
  `src/features/warehouse/control-center/` (HealthBanner, FlowSpine,
  BottleneckRail, LiveWorkPanel, LabourPanel, ZoneLoadPanel). It already exports
  `OUTBOUND_STAGES = replenish, pick, pack, load, dispatch`.
- Sanctioned supervisor action RPCs exist: `wms_reassign_task`,
  `wms_release_task`, `wms_set_task_priority`, `wms_acknowledge_exception`,
  `wms_assign_exception`, `wms_raise_exception`.
- Full outbound data model exists: `wms_pick_waves`, `wms_pick_wave_lines`,
  `wms_pack_cartons`, `wms_manifest_cartons`, `wms_loading_manifests`,
  `wms_dispatch_proofs`, `wms_dock_appointments`, `wms_trailer_visits`,
  `wms_yard_slots`, `wms_trailer_visit_load_summary`, `wms_exceptions`,
  `wms_labour_queue_view`, `wms_operator_board_view`, `wms_license_plates`.
- A realtime fabric exists (`useWmsRealtimeSync`) that invalidates query-key
  prefixes per table — no polling required.

Weaknesses in `src/pages/warehouse/OutboundDashboard.tsx` (253 lines):

1. **Reporting, not control.** Eight KPI tiles plus three state-count breakdowns.
   Nothing tells the supervisor whether outbound is healthy, degraded or blocked,
   and nothing explains *why*.
2. **Client-side aggregation at scale.** It pulls up to 1000 cartons, 500 waves,
   500 manifests, 500 exceptions, 500 visits and 500 slots into the browser and
   filters with `Array.filter`. It silently truncates on a busy warehouse, so the
   numbers become wrong exactly when the tower matters.
3. **Duplicated rules.** "Late", "awaiting seal", "short scan" are re-derived here
   with regex on `kind` and ad-hoc state lists, diverging from the SQL health
   rules used by the supervisor tower and any alerting.
4. **No shipment lifecycle.** There is no per-wave or per-manifest row anywhere;
   waves, cartons and manifests are counted separately and never joined, so the
   chain Wave → Pick → Pack → Manifest → Dock → Trailer → Proof is invisible.
5. **No operational drill or action.** Tiles link to a whole page; a supervisor
   cannot reassign, re-prioritise, escalate or acknowledge from the tower.
6. **Shallow integrations.** Dock/yard appear as two counts; labour, hardware/scan
   events, QC and license plates are absent entirely, despite all existing.
7. **No SLA layer.** Only "planned departure in the past". No countdown, no
   at-risk window, no customer-facing aging.

Verdict: the module has made the reporting-versus-control mistake. It is replaced
outright, not patched.

## Target architecture

Rule: **all aggregation and all health rules live in SQL**; the client renders,
filters and acts. Same rule the supervisor control centre already follows.

### Server contract (new migration)

- `wms_outbound_health(p_business_id, p_warehouse_id)` → one JSON document:
  overall health + reason, and the outbound spine (release, pick, pack, stage,
  load, dispatch) with backlog / in-progress / unassigned / blocked /
  oldest-age / sla_at_risk / sla_breached / health per stage, derived from
  `wms_tasks`, `wms_pick_waves`, `wms_pack_cartons`, `wms_loading_manifests`.
- `wms_outbound_shipments(p_business_id, p_warehouse_id, p_filter)` → the
  lifecycle board: one row per outbound load (wave joined to its cartons,
  manifest, dock appointment, trailer visit, proof) with lifecycle stage,
  progress percentages (lines picked / cartons sealed / cartons loaded),
  `blocked_reason`, `minutes_to_departure`, risk bucket, and the drill route.
- `wms_outbound_bottlenecks(...)` → ranked causes scoped to outbound (short
  picks, packing starvation, unassigned load work, dock dwell, missing seal or
  signature, failed label print, manifest shortage), each with impact count and
  a route to the fixing surface.
- `wms_outbound_dock_board(...)` → dock occupancy and the trailer queue by
  reading `wms_dock_appointments`, `wms_trailer_visits`,
  `wms_trailer_visit_load_summary`, `wms_yard_slots`. Dock scheduling and yard
  remain the owners; the tower consumes them read-only.

All functions are `security definer`, business-scoped, and read only.

### Client module `src/features/warehouse/outbound-tower/`

- `contract.ts` — types plus pure presentation helpers; reuses the shared
  health/risk vocabulary from `control-center/contract.ts` instead of forking it.
- `useOutboundTower.ts` — four thin RPC hooks, keys registered for realtime.
- Components: `OutboundHealthBanner`, `OutboundFlowSpine` (reuses `FlowSpine`),
  `ShipmentLifecycleBoard` (the centrepiece: per-load timeline row with stage
  chips, progress, blocker, departure countdown, row actions), `LoadingLane`
  (cartons awaiting pack / QA / label / manifest / loading as operational
  states), `DockYardStrip`, `OutboundBottleneckRail` (reuses `BottleneckRail`),
  `ExceptionRail`, plus `LabourPanel` and `LiveWorkPanel` reused unchanged with
  the outbound task-type filter.
- `src/pages/warehouse/OutboundDashboard.tsx` is rewritten as pure composition
  (~120 lines, no `supabase` import, no aggregation).

### Real time and actions

- Register `wms-outbound-*` key prefixes in `useWmsRealtimeSync` under
  `wms_tasks`, `wms_pick_waves`, `wms_pack_cartons`, `wms_manifest_cartons`,
  `wms_loading_manifests`, `wms_exceptions`, `wms_trailer_visits`,
  `wms_dock_appointments`, `wms_yard_slots`. Scan/print hardware events already
  land as rows on these tables (carton scans, LPN scans, gate events), so the
  board moves when a scanner fires. No polling; refresh button kept only as a
  manual override.
- Row-level supervisor actions call existing RPCs only: reassign, release,
  re-prioritise, acknowledge/assign exception, raise exception. No direct
  writes to `wms_tasks` or manifests from the tower.

### Removal

`OutboundDashboard`'s tile grid, `StateBreakdown` usage and all its client
queries are deleted. `DashboardPrimitives` stays only while `InboundDashboard`
still uses it; nothing is kept as fallback and no legacy path remains.

## Visualisation

Uses the existing design system and `recharts` (already a dependency) for the
one place a chart earns its place: departure-window load over the next shift.
Everything else is a purpose-built operational board — a shipment lifecycle rail
and a dock occupancy strip — since no third-party widget models these. No new
dependencies.

## Phases

1. Migration: the four outbound RPCs.
2. `outbound-tower` feature module: contract + hooks + realtime key registration.
3. Components: health banner, flow spine, shipment lifecycle board.
4. Loading lane, dock/yard strip, bottleneck and exception rails, labour.
5. Page rewrite as composition; delete the old implementation.
6. Guard tests: architecture test asserting the page performs no client-side
   aggregation and imports no `supabase` client, plus a no-poll test
   (`refetchInterval` absent) and a realtime key-coverage test.

---

## Status: CLOSED — all phases delivered (2026-08-04)

1. Migration — `wms_outbound_health`, `wms_outbound_shipments`,
   `wms_outbound_bottlenecks`, `wms_outbound_dock_board` shipped as
   security-definer, business-scoped, read-only RPCs.
2. `outbound-tower` module — `contract.ts` (types + pure helpers, reusing the
   control-centre health vocabulary), `useOutboundTower.ts` (five hooks,
   keys registered for realtime).
3. `HealthBanner` + `FlowSpine` reused; `ShipmentLifecycleBoard` and
   `ShipmentActions` (guarded RPC transitions with `row_version`) shipped.
4. `LoadingLane`, `DockYardStrip`, `OutboundBottleneckRail`, `ExceptionRail`,
   `DepartureTimeline`, plus `LiveWorkPanel` / `LabourPanel` reused with the
   outbound task-type filter.
5. `OutboundDashboard.tsx` rewritten as pure composition — no supabase import,
   no client aggregation; the tile-grid implementation deleted.
6. Guards — `src/test/architecture/outbound-control-tower.test.ts` (6 tests):
   page composes only, no aggregation, no polling, every tower key prefix
   realtime-registered on every outbound-moving table, legacy path gone.
   `tsgo --noEmit` clean.
