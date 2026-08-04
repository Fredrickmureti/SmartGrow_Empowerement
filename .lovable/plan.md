# Warehouse Supervisor Control Center — Audit Findings & Rebuild Plan

## What a Supervisor Control Center is

A supervisor does not own stock, tasks or people — they own **execution flow**. The
module must continuously answer five questions: Is the warehouse healthy? Where is work
backing up? Why? Who is affected? What do I do next? That is a live control surface over
the receiving → inspection → put-away → storage → replenishment → pick → pack → load →
dispatch chain, not a report of what happened.

## Audit findings (verified in code)

Strengths — the substrate is genuinely enterprise-grade and must be reused, not rebuilt:

- Execution ledger exists: `wms_task_events` (append-only) plus the `wms_task_telemetry`
  RPC (`src/features/warehouse/telemetry/useTaskTelemetry.ts`) derives throughput, dwell,
  exception rate and lease-loss with no client aggregation.
- Live task/queue projections exist: `wms_labour_queue_view`, `wms_operator_board`,
  utilisation view (`src/features/warehouse/labour/*`).
- Real supervisor intents already exist as RPCs, not client UPDATEs: `wms_reassign_task`,
  `wms_release_task`, `wms_set_task_priority` (`useLabourQueue.ts`).
- A single realtime channel already invalidates every WMS surface, per table → query-key
  prefix (`src/features/warehouse/realtime/useWmsRealtimeSync.ts`).
- Domain surfaces exist and are deep: exceptions (full class/owner/resolution/evidence
  vocabulary), dock scheduling, yard + trailer visits, replenishment, receiving sessions,
  waves, pack, manifests, QC, counts, layout designer.

Weaknesses — concentrated entirely in the control-center layer:

- `src/pages/warehouse/SupervisorDashboard.tsx` (185 lines) is a statistics page: 4 metric
  tiles (open / SLA breached / unassigned / expired leases), two `StateBreakdown` bar lists,
  and a productivity table keyed by a truncated raw UUID (`id.slice(0,8)`) — operators are
  not even named. It answers "how many", never "where" or "why".
- No flow model. Nothing in the UI represents the stage chain, so bottleneck location is
  not derivable. `dashboard`, `dashboard/inbound`, `dashboard/outbound`,
  `dashboard/supervisor` are four disconnected tile pages that each re-implement their own
  queries — duplicated aggregation, no shared health contract.
- No health state. There is no healthy/degraded/critical/blocked concept anywhere; tone is
  computed ad hoc per tile as `count > 0 ? "bad" : "ok"`.
- Aggregation happens in the browser: `SupervisorDashboard` pulls up to 1000 open tasks and
  2000 completed tasks and reduces them in a `Map`. This will not scale and cannot be
  reused by mobile or alerting.
- No server-side health/flow RPC exists — confirmed: the only matching function in the
  database is `wms_task_telemetry`. Nothing computes stage-level backlog, aging, or SLA risk.
- Zero cross-domain consumption on the supervisor page: exceptions, docks, yard,
  replenishment, receiving, dispatch and hardware are all absent, even though every one of
  them already has a hook.
- No supervisor action affordance on the page — the existing reassign/release/priority RPCs
  are unreachable from the control center.
- No hardware visibility, despite `hooks/hardware/usePrinterStatus`, `useHardwareProxy`,
  `useDeviceAssignments` and scanner-session infrastructure existing.
- Passive: it never surfaces "act now" work — no aging buckets, no blocked-on-event
  reason, no escalation path.

Verdict: the substrate is sound; the control center is a reporting dashboard mistakenly
placed where an operational command surface belongs. Rebuild the control layer, keep the
domain layer.

## What we will build

One command center at `/warehouse-app/dashboard/supervisor`, structured top-down by
decision urgency:

1. **Health banner** — a single computed warehouse state (healthy / degraded / critical /
   blocked) with the one-line reason that produced it and the worst-offending stage.
2. **Flow spine** — the stage chain (Receive → Inspect → Put-away → Store → Replenish →
   Pick → Pack → Load → Dispatch) rendered as connected stages, each showing backlog,
   oldest item age, SLA-at-risk count, and stage health. Clicking a stage drills into it.
3. **Bottleneck & risk rail** — ranked list of where work is accumulating and why
   (starved, blocked on QC, no operator, dock delayed, stock unavailable), each row linking
   to the owning surface and offering the corrective action.
4. **Live work panel** — the queue ordered by risk, not by time: overdue, aging,
   unassigned, blocked-on-event, with inline reassign / release / re-prioritise / escalate
   using the existing RPCs.
5. **Labour panel** — named operators (joined through the operator board, no raw UUIDs),
   active/idle/overloaded, workload distribution and utilisation.
6. **Constraint panel** — docks, yard trailers, replenishment starvation, exceptions and
   hardware health, each consumed from its existing hook (no duplicated logic, no new
   sources of truth).
7. **Geography** — stage/zone heat over the existing `stock_locations` layout so
   bottlenecks have a physical location.

Everything is realtime through the existing channel; no polling and no manual refresh.

## Technical approach

- **New server-side contract.** One migration adds a `wms_flow_health` RPC (security
  definer, business/warehouse scoped) returning per-stage backlog, oldest age, SLA-at-risk
  and breached counts plus a derived stage health, computed from `wms_tasks` /
  `wms_task_events` / `wms_exceptions` / `wms_dock_appointments` / `wms_replen_orders`. A
  second RPC returns ranked bottleneck reasons. Health rules live in SQL so mobile,
  alerting and the desktop board cannot drift. No client-side row reduction.
- **New feature module** `src/features/warehouse/control-center/` owning the health
  contract, hooks (`useFlowHealth`, `useBottlenecks`, `useControlCenterConstraints`), and
  the presentation components. Domain data is consumed via existing hooks
  (`useLabourQueue`, `useSupervisorActions`, `useOperatorBoard`, `useDockScheduling`,
  `useYard`, exception hooks, hardware hooks) — no new queries against domains that already
  have one.
- **Realtime.** Register the new query-key prefixes in the existing
  `TABLE_INVALIDATIONS` map; no second channel.
- **Visualization.** Use the libraries already installed — `recharts` for trend/heat,
  `@tanstack/react-table` + `react-virtual` for the risk-ordered work grid,
  `framer-motion` for state transitions. The flow spine is a small purpose-built component
  driven by the health contract (a generic graph library would add weight without
  improving a fixed 9-stage chain). No new dependencies unless the heat map proves it needs
  one.
- **Removal.** `SupervisorDashboard.tsx` is deleted and replaced. The overlapping
  `dashboard/inbound` and `dashboard/outbound` tile pages are refactored to consume the
  same flow-health contract (inbound = receiving→put-away slice, outbound =
  pick→dispatch slice) so the aggregation exists once; their duplicated inline queries and
  `StateBreakdown` blocks go away. No legacy layout is kept as a fallback.
- **Guards.** An architecture test pins that the control center performs no client-side
  task aggregation and that every stage in the flow contract has a drill-down route that
  exists.

## Delivery phases

1. Health contract + `wms_flow_health` / bottleneck RPCs + migration + hooks.
2. Health banner + flow spine, replacing `SupervisorDashboard`.
3. Bottleneck rail + risk-ordered live work panel with supervisor actions.
4. Labour panel with named operators; delete the UUID productivity table.
5. Constraint panel (docks, yard, replenishment, exceptions, hardware).
6. Geography heat over the existing layout.
7. Refactor inbound/outbound towers onto the shared contract; delete duplicated
   aggregation; add architecture guard tests.
