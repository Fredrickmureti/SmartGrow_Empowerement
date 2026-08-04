# Inbound Control Tower — architecture audit and rebuild

## What an Inbound Control Tower is

It is not Receiving, Dock Scheduling, Yard, QC or Cross-dock. It is the
supervisory layer that watches one business chain end to end and answers
"what is happening right now, what is stuck, and what do I do about it":

```text
PO -> ASN -> appointment -> gate -> yard -> dock -> unload -> capture
   -> inspect/QC -> cross-dock decision -> putaway -> inventory available
```

Reporting answers "what happened". A tower answers "what is happening",
"why is it late", and "act now".

## Audit findings (verified against the code and database)

**The current page is a reporting widget, not a tower.**
`src/pages/warehouse/InboundDashboard.tsx` is 175 lines that run three raw
PostgREST reads (`wms_dock_appointments`, `wms_receiving_sessions`,
`wms_exceptions`), aggregate them in the browser with `.filter()`, and render
four KPI tiles plus three "count by state" breakdowns. It classifies inbound
exceptions with a regex on `kind` (`/receiv|putaway|asn|dock|qc/`) — business
rules living in a client-side regex.

**No server-side inbound contract exists.** The database has
`wms_outbound_health`, `wms_outbound_shipments`, `wms_outbound_bottlenecks`,
`wms_outbound_dock_board` and the generic `wms_flow_health` /
`wms_flow_bottlenecks`. There is no `wms_inbound_*` function at all. The
outbound tower is the correct pattern already proven in this codebase; inbound
never received the equivalent.

**Nothing is joined.** The page shows appointments, sessions and exceptions as
three unrelated lists. No row anywhere connects an appointment to its trailer
visit, its dock, its receiving session, its lines, its QC inspections, its
cross-dock opportunities and its putaway tasks — even though every foreign key
needed for that join already exists:
`wms_receiving_sessions.appointment_id / dock_id / source_doc_id`,
`wms_trailer_visits.appointment_id / dock_id / yard_slot_id`,
`wms_gate_events.visit_id`, `wms_crossdock_opportunities.receiving_line_id`,
`wms_qc_inspections.source_doc_id`, `wms_tasks` (putaway).

**Whole stages are invisible.** Gate check-in, yard dwell, dock occupancy,
QC/quarantine, cross-dock decisions, putaway backlog, labour and staging are
never surfaced on the inbound page, although each has a working module
(`features/warehouse/yard`, `dock`, `receiving`, `crossdock`, `labour`,
`control-center`).

**Realtime is partial.** `useWmsRealtimeSync` invalidates
`OUTBOUND_QUERY_PREFIXES` from many tables but has no inbound equivalent, so
gate events, appointment transitions, QC results and scanner-driven line
captures do not consistently move this page.

**No supervisor actions.** The page is read-only. A supervisor cannot
prioritise an unload, assign a dock, escalate a delay, acknowledge an
exception or reassign receiving labour from it.

**Strengths worth keeping:** the outbound tower's contract-in-SQL pattern, the
shared health vocabulary in `control-center/contract.ts`, the RPC-only write
discipline in yard/dock/receiving, and the exception domain (`wms_exceptions`
with severity, `due_by`, class, owner_role, escalation).

## The rebuild

### 1. Server-side inbound contract (SQL, mirrors outbound)

Four security-definer RPCs. All rules — health thresholds, blocker
classification, SLA risk — live here so desktop, mobile and future alerting
cannot drift:

- `wms_inbound_health(business, warehouse)` — overall state plus a stage
  spine: `appointment → gate → yard → dock → unload → capture → inspect →
  crossdock → putaway → available`, each with backlog, in-progress,
  unassigned, blocked, oldest age, SLA at-risk and breached.
- `wms_inbound_arrivals(business, warehouse, limit)` — one row per inbound
  load, joined across appointment, trailer visit, gate events, yard slot,
  dock, receiving session and its progress, QC, cross-dock and putaway tasks.
  Carries lifecycle stage, risk (`breached | blocked | at_risk | normal |
  done`), minutes-to-window, dwell, receive %, discrepancy counts and a
  drill route.
- `wms_inbound_bottlenecks(business, warehouse)` — ranked reason codes
  (`no_asn`, `late_arrival`, `yard_dwell`, `no_dock`, `unload_stalled`,
  `short_receipt`, `over_receipt`, `damaged`, `qc_hold`, `crossdock_expiring`,
  `putaway_backlog`, `no_operator`, `sla_breached`) with impact count and the
  route that clears each.
- `wms_inbound_dock_board(business, warehouse)` — inbound docks, occupancy,
  waiting trailers with waiting minutes, yard slot availability.

Exception classification moves from the client regex into SQL, keyed off
`wms_exceptions.kind` and its aggregate type.

### 2. Feature module `src/features/warehouse/inbound-tower/`

Structured exactly like `outbound-tower`:

- `contract.ts` — types, stage order, labels, reason-code → action text, pure
  helpers. Re-exports the shared health vocabulary from `control-center`; no
  forked tone/label tables.
- `useInboundTower.ts` — thin query hooks, no client aggregation, exporting
  `INBOUND_QUERY_PREFIXES`.
- Components: `ArrivalLifecycleBoard`, `InboundBottleneckRail`,
  `DockYardStrip` (inbound variant), `ReceivingLane`, `InspectionRail`,
  `PutawayReadinessPanel`, `ArrivalTimeline`, `InboundActions`.
- Shared pieces (`HealthBanner`, `FlowSpine`, `LabourPanel`, `LiveWorkPanel`,
  `ExceptionRail`) are reused, not copied.

### 3. Page rebuild

`InboundDashboard.tsx` is replaced (not extended) with the tower layout:
health banner → inbound flow spine (click a stage to filter) → ranked
blockers → arrival lifecycle board → dock and yard strip → receiving lane →
inspection and cross-dock rail → putaway readiness → labour → live arrival
timeline. The old KPI tiles, the three `StateBreakdown` cards and the regex
classifier are deleted outright; no fallback path is kept.

### 4. Supervisor actions in place

Each acts through the existing sanctioned RPCs — no new write paths:
prioritise unload, assign/reassign dock, escalate delay, acknowledge or assign
an exception, approve or reject a cross-dock opportunity, release putaway,
assign receiving labour.

### 5. Realtime

`INBOUND_QUERY_PREFIXES` registered in `useWmsRealtimeSync` against
`wms_dock_appointments`, `wms_trailer_visits`, `wms_gate_events`,
`wms_receiving_sessions`, `wms_receiving_lines`, `wms_qc_inspections`,
`wms_crossdock_opportunities`, `wms_tasks`, `wms_exceptions`,
`wms_license_plates`. Scanner, mobile and printer events already land as rows
on these tables, so hardware activity moves the tower with no polling. The
manual Refresh button stays only as an explicit override.

### 6. Visualisation

Reuse the project's existing primitives and Recharts where already in use; add
no new charting dependency. The timeline and dock board follow the existing
`DockTimeline` / `DockYardStrip` patterns.

### 7. Documentation and guards

- `docs/adr/0111-inbound-control-tower.md` — the contract and its invariants
  (one server-side contract; no client-side aggregation; consume, never
  duplicate, yard/dock/receiving/QC/cross-dock).
- Architecture test asserting the inbound page performs no direct
  `wms_*` table aggregation and no exception classification in TypeScript.

## Delivery order

1. SQL migration: the four `wms_inbound_*` RPCs.
2. `inbound-tower` contract + hooks + realtime registration.
3. Tower components.
4. Page rebuild and deletion of the old implementation.
5. Supervisor actions.
6. ADR + architecture test.

## Delivery status — closed 2026-08-04

All six delivery steps are shipped and verified.

1. **SQL contract** — `wms_inbound_health`, `wms_inbound_arrivals`,
   `wms_inbound_bottlenecks`, `wms_inbound_dock_board` deployed and executed
   against live data.
2. **Module** — `src/features/warehouse/inbound-tower/` with `contract.ts`
   (types, stage order, reason-code labels/actions, shared health vocabulary
   re-exported from `control-center`) and `useInboundTower.ts` (five thin
   hooks, `INBOUND_QUERY_PREFIXES`, no client aggregation).
3. **Components** — `ArrivalLifecycleBoard`, `ArrivalActions`,
   `InboundBottleneckRail`, `InboundDockStrip`, `ArrivalWindowTimeline`,
   `InboundExceptionRail`, `InboundReadinessPanel` (inspection, cross-dock and
   put-away tail). `HealthBanner`, `FlowSpine`, `LabourPanel` and
   `LiveWorkPanel` are reused from `control-center`, not copied.
4. **Page** — `InboundDashboard.tsx` rebuilt; the KPI tiles, `StateBreakdown`
   cards and the client-side exception regex are deleted with no fallback.
5. **Actions** — mark arrived, assign dock, start receiving and escalation act
   through existing sanctioned RPCs.
6. **Realtime + guards** — inbound prefixes registered on `wms_tasks`,
   `wms_receiving_sessions`, `wms_qc_inspections`, `wms_dock_appointments`,
   `wms_exceptions`, `wms_trailer_visits`, `wms_yard_slots`,
   `wms_crossdock_opportunities`, `wms_license_plates`. Polling removed.
   `docs/adr/0111-inbound-control-tower.md` and the eight-case architecture
   guard in `src/test/architecture/inbound-control-tower.test.ts` pin the
   invariants; typecheck and the guard suite pass.

**Deviations from the plan, deliberate:** `wms_gate_events` and
`wms_receiving_lines` are not in the realtime publication, so gate custody and
line capture are invalidated through the parent visit and session rows.
The `ReceivingLane` / `InspectionRail` / `PutawayReadinessPanel` trio collapsed
into `InboundReadinessPanel` plus the arrival board's per-stage detail, which
avoids three panels re-reading the same contract fields. The ADR is 0111, not
0110, because 0110 was already taken by dispatch proof.
