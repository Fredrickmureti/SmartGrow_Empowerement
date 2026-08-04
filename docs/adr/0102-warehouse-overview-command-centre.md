# ADR 0102 — Warehouse Overview is the command centre

Status: Accepted (2026-08-04)
Depends on: ADR 0079 (Inventory vs. WMS split), ADR 0101 (WMS domain, FSM & event catalog),
ADR 0111 (inbound spine). Supersedes the "supervisor tower" surface introduced in Phase 4 §6.

## Context

`/warehouse-app/dashboard` was the landing page of the Warehouse app and the
first screen every operator, supervisor and manager saw. It rendered three
configuration counters — warehouses, locations, locations with
`structure_level` set — plus a "no layout authored" nudge. Nothing on it was
operational: it did not know whether work was flowing, what was blocked, who
was on shift, whether the handhelds were alive, or what had just happened on
the floor. It was a setup summary occupying the most valuable screen in the
module.

The operational content existed, but as a *second* home page:
`/warehouse-app/dashboard/supervisor` ("Supervisor tower") held the health
banner, flow spine, bottleneck rail, live work queue, labour and zone load,
all backed by server-side aggregates (`wms_flow_health`,
`wms_flow_bottlenecks`, `wms_zone_load`). Two competing landing surfaces is
exactly the duplicate execution path this codebase forbids: the same numbers
reachable by two routes, with the default route showing the weaker one.

Three operational lenses had no owner anywhere: physical capacity (is there
space, is staging full, are the docks saturated), equipment health (a
warehouse stops when the handheld stops), and the activity feed (proof from
the event fabric that work is actually moving).

## Decision

**There is exactly one warehouse command centre: the Overview at
`/warehouse-app/dashboard`.**

1. `WarehouseDashboard.tsx` (configuration summary) and
   `SupervisorDashboard.tsx` (supervisor tower) are **deleted**. No legacy
   fallback, no compatibility page. `dashboard/supervisor` redirects to
   `dashboard`, preserving deep links and bookmarks.
2. The new `src/pages/warehouse/WarehouseOverview.tsx` composes, in triage
   order: health banner → ranked priorities → flow spine → inbound/outbound
   tower summaries → live work → capacity, labour, exceptions, equipment,
   zone load → activity feed.
3. A new feature module `src/features/warehouse/overview` owns only what no
   other module owned:
   - `wms_overview_capacity` — space, staging, quarantine and dock saturation.
   - `wms_equipment_health` — device heartbeat classification (`online`,
     `stale` >15 min, `error`, `unknown`).
   - `wms_activity_feed` — a read-only projection of `business_event_outbox`
     filtered to warehouse topics.
   - `rankPriorities()` — a **pure** merge of the flow, inbound and outbound
     bottleneck feeds into one ranked, de-duplicated stack.
4. The Overview **aggregates, it does not compute**. It performs no Supabase
   query of its own; every figure is produced in SQL by the module that owns
   the domain, so the board can never drift from the mobile, alerting or
   tower view of the same number.
5. Setup affordances (layout editor, warehouse master data) leave the home
   page and stay in their own surfaces. Configuration is not an operational
   priority and does not compete for the operator's first glance.

## Consequences

- One authoritative answer to "what is happening in my warehouse right now",
  one route, one set of numbers.
- `OVERVIEW_QUERY_PREFIXES` joins the `useWmsRealtimeSync` invalidation map,
  so the Overview follows the floor over the existing WMS realtime channel —
  no polling anywhere on the page.
- The priority stack is the module's single ranking rule. Any new bottleneck
  feed becomes visible on the home page by feeding `rankPriorities()`; no
  new tile, no new page.
- Architecture tests in `src/test/architecture/wms-phase4-ux.test.ts` now
  assert the single-command-centre invariant: both legacy pages absent, the
  supervisor deep link redirecting, and the Overview free of direct queries
  and polling.

## Non-goals

- No change to the Inventory ledger, to any WMS aggregate, or to the FSM
  transition RPCs.
- No new write paths. Every action on the Overview is an existing action
  owned by the module it belongs to (live work assignment, exception triage).
