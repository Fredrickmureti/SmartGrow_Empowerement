# Warehouse Labour Management — Architecture Audit & Target Architecture

## 1. What WLM must be in an enterprise ERP

Labour Management is not a reporting page. It is the **execution orchestration layer** that sits above every warehouse work generator and answers, continuously: what work exists, how urgent is it, who is qualified and available to do it, who is overloaded, what is about to breach SLA, and what did each hour of paid labour actually earn.

Three responsibilities, in order:
1. **Work supply** — one canonical queue fed by every operational domain (receiving, putaway, replenishment, pick, pack, load, count, QC, returns, yard, cross-dock). Labour never creates warehouse work of its own.
2. **Resource supply** — operators as first-class warehouse resources: identity, shift, zone, equipment licence, skill, current load, attendance state.
3. **Matching + measurement** — assignment policy (skill/zone/equipment/load/SLA) plus engineered standards producing earned vs actual hours, utilisation, idle, travel and indirect labour, all derived from operational events, never keyed in.

## 2. Current architecture assessment

**Strengths (genuinely enterprise-grade, keep and build on):**
- **One canonical task engine.** `wms_tasks` is the single work surface; state is written only by `wms_transition_task`, `wms_claim_next_task`, `assign_wms_task` and the per-type completion RPCs, all with `row_version` optimistic locking and `FOR UPDATE SKIP LOCKED` claim (ADR 0101). Architecture tests forbid direct state writes. No competing queues — pick waves, QC, counts, receiving sessions, manifests, dock appointments are upstream aggregates that *emit* tasks.
- **Event catalog is real.** `wms_events_catalog` + `src/features/warehouse/events/topics.ts` with deprecation parity tests; producers go through `business_event_outbox`.
- **Labour metrics are event-derived.** `_wms_stamp_labour_metrics` trigger stamps `earned_seconds`/`actual_seconds` on transition to `done`; client writes to those columns are rejected. No manual data entry path exists.
- **Offline RF execution is solid.** `/wm` mobile app funnels every call through one IndexedDB queue and a server replay-guard RPC (`wms_replay_guarded_call` + `wms_client_scan_receipts`), guarded by an architecture test.
- **Enterprise printing exists and warehouse already uses it.** `PrintService` (intent → policy → ledger → render → dispatch); counts and dispatch register document policies.

**Weaknesses:**
- **W1 — Operators are not modelled.** An operator is a raw `auth.users` UUID on `assignee_user_id`. No link to `employees`, no skills, no forklift/equipment certifications, no zone eligibility, no shift or attendance awareness — despite HR already owning `employees`, `attendance`, `attendance_breaks`, shift schedule tables and a device/biometric attendance path.
- **W2 — Assignment is policy-free.** `wms_claim_next_task` orders by priority within a warehouse. It cannot filter by skill, licence, zone, equipment, or balance workload. Any authenticated user can hold any task.
- **W3 — Labour standards are one-dimensional.** `wms_task_standards(business_id, task_type, uom) → seconds_per_uom`. No zone/travel-distance, product-category, weight/volume, equipment or complexity dimension, and no split of the standard into setup + travel + handle + variable components. Earned hours are therefore only loosely engineered.
- **W4 — No indirect/idle/travel labour.** Only task-attached time is captured. Clocked hours minus task hours is invisible, so utilisation from `wms_operator_productivity_view` is an upper bound, not a measure.
- **W5 — Labour is a reporting page, not a control centre.** `LabourBoard.tsx` = standards CRUD + leaderboard + queue list, on 15–30s polling, with no supervisor actions (reassign, escalate, rebalance, reap).
- **W6 — Labour is not wired to realtime.** WMS has `useWmsRealtimeSync` (single org channel, table→query-key invalidation) but the Labour page polls instead.
- **W7 — No Labour documents.** No task sheet, pick/putaway sheet, shift summary or exception report, even though the platform pipeline is available and used next door.
- **W8 — No labour surface on mobile.** `/wm` has no "my work / my performance" view.

## 3. Business-event flow (target)

```text
Domain aggregate (ASN, wave, count, QC, return, replen rule, dock appt)
        │  emits work
        ▼
wms_tasks  ──► outbox topic warehouse.task.available
        │
        ▼
Labour orchestrator
   ├─ eligibility filter (skill, licence, zone, shift, attendance state)
   ├─ workload balance + SLA urgency ranking
   └─ offer / auto-assign / claim  ──► warehouse.task.assigned
        ▼
Operator (RF gun, tablet, wearable, voice) executes
   heartbeat ──► lease extension; offline ops replay-guarded
        ▼
completion RPC ──► state=done ──► _wms_stamp_labour_metrics
        ▼
earned vs actual ──► productivity rollups ──► supervisor control centre
        ▼
shift close ──► shift summary document + indirect-time reconciliation
```

## 4. Task lifecycle (as implemented, to be preserved)

`pending → available → claimed/assigned → in_progress ⇄ paused → done` with `exception` and `cancelled` branches; lease expiry reaps `claimed|in_progress` back to `available` and raises a `wms_exceptions` row. Extension work must go through these RPCs, never around them.

## 5. Operator lifecycle (missing today, to be added)

`employee → warehouse operator profile (zones, equipment, skills, certifications w/ expiry) → shift roster → clock-in (HR attendance / badge / biometric) → available → assigned → executing → break → clock-out → shift performance`.

Design rule: **HR owns the person, attendance, and shift calendar. WMS owns warehouse capability and live availability.** A `wms_operators` profile row references `employees.id` and never duplicates HR fields.

## 6. Hardware assessment

RF/handheld/scanner integration is already event-driven through `hardwareClient`, the scanner kernel, and the `/wm` offline queue; ADR 0037 gives the browser/Electron/LAN-agent topology and already carries the biometric-attendance protocol. The gap is not transport — it is that **device activity does not feed labour availability**. Target: badge/biometric clock events and device session heartbeats become the source of operator "on-shift / on-break / idle" state, so travel and idle time can be inferred instead of assumed.

## 7. Recommended target architecture

**Data**
- `wms_operators` — operator profile keyed to `employees.id`, per warehouse; home zone(s), equipment classes, active flag.
- `wms_operator_skills` / `wms_operator_certifications` — skill or licence with proficiency and expiry; expired certification silently removes eligibility.
- `wms_operator_shifts` — resolved from HR shift schedules, plus live `wms_operator_status` (on_shift / break / idle / executing) fed by attendance and task events.
- `wms_task_standards` extended to a **dimensioned** standard: optional `warehouse_id`, `zone_id`, `product_category_id`, `equipment_class`, plus `setup_seconds`, `travel_seconds_per_metre`, `handle_seconds_per_uom`, and a resolution function that picks the most specific active standard. Existing flat rows keep working as the fallback tier.
- `wms_labour_time_entries` — indirect/idle/travel/break time so clocked hours reconcile to earned hours.

**Server logic**
- `wms_claim_next_task` gains eligibility filtering (skill, certification, zone, equipment, shift) and a balancing term; `assign_wms_task` validates eligibility and refuses ineligible assignment with a typed error.
- `wms_resolve_labour_standard(...)` used by `_wms_stamp_labour_metrics` so earned seconds are computed from the dimensioned standard.
- Supervisor RPCs: reassign, escalate priority, force-release lease — all as guarded transitions, no direct UPDATEs.

**UI — reuse, do not rebuild**
Available libraries: TanStack Table + TanStack Virtual (queues, operator boards, dense grids), Recharts (trend/utilisation charts), dnd-kit (drag reassign between operators), react-day-picker + date-fns (shift/roster date selection), plus the existing shadcn design system, command palette (`cmdk`) and `useWmsRealtimeSync`. **No Gantt or Kanban library is installed and none should be added** — a shift timeline is a virtualised table row with positioned bars, and a reassignment board is a dnd-kit surface over TanStack Table, not a bespoke Kanban engine. No hand-rolled charting, no manual virtualisation, no custom drag logic.
The Labour Board becomes a supervisor control centre: live queue (virtualised, SLA-ranked), operator board (status, current task, load, utilisation), zone workload view, exception/SLA alert rail, and supervisor actions — all driven by `useWmsRealtimeSync` invalidation rather than polling.

**Printing** — register Labour document policies with `PrintService`: task sheet, pick/putaway sheet, shift summary, operator assignment sheet, labour exception report. No independent generation path.

## 8. Phased implementation strategy

- **Phase A — Operator model.** `wms_operators`, skills, certifications, HR/`employees` linkage, RLS + grants; operator admin UI on the existing table/dialog patterns. No behaviour change to assignment yet.
- **Phase B — Eligibility-aware assignment.** Extend `wms_claim_next_task`/`assign_wms_task` with eligibility and balancing; typed refusal errors; e2e coverage alongside `labour-claim.spec.ts`.
- **Phase C — Dimensioned labour standards.** Standard resolution function, extended standards table and editor, trigger switched to the resolver; historical earned figures untouched.
- **Phase D — Live control centre.** Replace polling with `useWmsRealtimeSync`; supervisor board (queue + operator board + zone load + SLA rail) using TanStack Table/Virtual, Recharts, dnd-kit reassign; supervisor action RPCs.
- **Phase E — Shift, attendance & indirect time.** Shift resolution from HR, attendance/badge-driven operator status, `wms_labour_time_entries`, true utilisation and idle/travel reporting.
- **Phase F — Documents & mobile.** Labour print policies (task sheet, shift summary, exception report) via `PrintService`; `/wm` "my work / my performance" screen inside the existing offline queue contract.

Each phase ships with a migration (grants + RLS), architecture-test updates where a new invariant is introduced, and no bypass of the canonical task RPCs.

## 9. Technical notes

- Every new public table gets explicit `GRANT`s alongside RLS, per project convention.
- All new WMS write paths go through `SECURITY DEFINER` RPCs with `row_version`; the aggregate-wrapper layer in `src/features/warehouse/aggregates/*` remains the only client caller.
- New topics must be added to both `wms_events_catalog` and `src/features/warehouse/events/topics.ts` to satisfy the parity test.
- Mobile additions must route through `src/apps/warehouse-mobile/offlineQueue.ts`.
