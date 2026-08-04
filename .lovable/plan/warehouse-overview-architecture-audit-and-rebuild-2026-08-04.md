# Warehouse Overview — architecture audit and rebuild

## What a Warehouse Overview must be

The operational landing page a supervisor opens at 06:00 to answer five questions:
is the warehouse healthy, what is flowing in and out right now, where is it
breaking, who and what is available to fix it, and what do I do first. It is not
warehouse setup, not CRUD, not a layout authoring surface.

## Audit findings (verified in this codebase)

**1. The Overview is a configuration summary, not an operations page.**
`src/pages/warehouse/WarehouseDashboard.tsx` (the `/warehouse-app/dashboard`
"Overview" nav entry) renders exactly three tiles — warehouse count, total
`stock_locations` rows, and rows with `structure_level` set — plus a
"no layout authored yet" nudge into the layout editor. Every number is
administrative. Nothing on the page reflects work, flow, risk, or people. This
is the confusion between warehouse administration and warehouse operations the
audit was looking for, and it is the page's entire content.

**2. The real command centre exists, but it is buried one level down.**
`SupervisorDashboard.tsx` at `/warehouse-app/dashboard/supervisor` already
implements health banner, flow spine, bottleneck rail, live work queue, labour
and zone load — all fed by server-side SQL (`wms_flow_health`,
`wms_flow_bottlenecks`, `wms_zone_load`) through
`src/features/warehouse/control-center`. So the enterprise-grade substrate is
built; it is simply not the home page. We have two competing "overview" pages,
one weak and default, one strong and hidden.

**3. Rich domain telemetry is already available and unconsumed by the Overview.**
Confirmed RPCs: `wms_inbound_health`, `wms_inbound_arrivals`,
`wms_inbound_dock_board`, `wms_inbound_bottlenecks`, `wms_outbound_health`,
`wms_outbound_shipments`, `wms_outbound_dock_board`, `wms_outbound_bottlenecks`,
`wms_location_overview` (capacity), `wms_labour_demand`, `wms_labour_plan`,
`wms_operator_scorecard`, `wms_task_telemetry`,
`wms_detect_operational_exceptions`. Feature modules `inbound-tower`,
`outbound-tower`, `exceptions`, `labour`, `telemetry`, `yard`, `dock`, `counts`,
`replenishment`, `returns`, `crossdock` all expose typed hooks. Live refresh
already exists via `useWmsRealtimeSync` mounted in `WarehouseLayout`, and the
event vocabulary is formalised in `events/topics.ts` + `business_event_outbox`
(ADR 0076/0079/0101). None of this reaches the Overview.

**4. Missing operational lenses.** No capacity/occupancy view, no equipment
health (device/printer/scanner state lives in `device_assignments` and the
hardware app but is invisible to warehouse operators), no activity timeline
even though `events/OutboxTimeline.tsx` exists, and no ranked "do this first"
guidance surfaced at the top level.

**Verdict:** the current Overview must be deleted, not improved. The Supervisor
tower is promoted to Overview and widened from a task-flow board into a full
warehouse command centre.

## The rebuild

`/warehouse-app/dashboard` becomes the single authoritative command centre,
composed top-down in decision order:

```text
1  Command bar      warehouse + shift selector, live status, last event time
2  Health banner    overall state, reason, worst stage        (existing)
3  Priority stack   ranked "address this first" actions, merged from flow,
                    inbound, outbound and exception bottleneck feeds
4  Flow spine       receive -> dispatch, backlog/age/SLA      (existing)
5  Inbound | Outbound summary strips, each linking into its control tower
6  Exceptions rail  open + overdue, typed, one click to resolve
7  Live work        risk-ordered queue with inline actions    (existing)
8  Labour | Capacity | Equipment health  three-up operational readiness row
9  Zone heat        occupancy + congestion by zone, drill to layout
10 Activity feed    live warehouse event stream from the outbox
```

Every panel drills into the owning module; the Overview aggregates and never
duplicates their logic.

## Removals (no fallbacks kept)

- Delete `WarehouseDashboard.tsx` (setup tiles) entirely.
- Delete `SupervisorDashboard.tsx`; its composition moves into the Overview.
- Remove the "Supervisor tower" nav entry; redirect
  `/warehouse-app/dashboard/supervisor` to `/warehouse-app/dashboard` so deep
  links survive.
- The layout/location counts move to where they belong — the Warehouses list
  and layout workspace — and disappear from operations.

## Technical approach

- New feature module `src/features/warehouse/overview/`: `contract.ts` (typed
  shapes), `useWarehouseOverview.ts` (parallel React Query reads against the
  existing RPCs, single query-key namespace, invalidated by the existing WMS
  realtime channel), plus one component per panel. `control-center` panels are
  reused as-is, not forked.
- Aggregation stays in SQL. Two new read-only RPCs are added only where no
  server-side aggregate exists: `wms_overview_capacity` (occupancy, blocked,
  quarantine, staging congestion, dock utilisation from `wms_location_overview`
  + dock boards) and `wms_equipment_health` (device/printer/scanner online,
  stale-heartbeat and error counts scoped to the warehouse's branch). Both are
  `SECURITY DEFINER`, business-scoped, `GRANT EXECUTE TO authenticated`.
- Priority stack is a pure client-side merge/rank of already-typed bottleneck
  feeds — no new severity logic invented in the UI.
- Visualisation uses the libraries already in the stack: `recharts` for gauges
  and sparklines, `@tanstack/react-table` for the work grid, design-system
  primitives elsewhere. No new dashboard dependency is introduced, since the
  existing pair covers gauges, trends and enterprise grids.
- Zone heat map is rendered from `stock_locations` structure data at a
  zone/aisle granularity, colour-scaled on load — reusing the layout
  workspace's geometry helpers rather than a second layout model.
- Realtime: no polling. The overview subscribes through the existing
  `useWmsRealtimeSync` invalidation contract; the activity feed reads
  `business_event_outbox` filtered to `warehouse.*` / `stock.movement.*`.

## Documentation

New ADR `docs/adr/0102-warehouse-overview-command-centre.md` recording the
promotion of the supervisor tower to the Overview, the deletion of the setup
dashboard, and the rule that the Overview aggregates and never owns
warehouse logic.
