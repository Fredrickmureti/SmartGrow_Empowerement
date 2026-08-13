# Enterprise Warehouse Labour Management (WLM) — Implementation Plan

Authoritative status document. Update it after every implementation step.

## Vision

Labour is a managed resource, not a report. The system must know who is
available, what they are qualified to do, what the work *should* take, what it
actually took, and what to do when reality diverges. One task engine
(`wms_tasks`, ADR 0101) remains the single source of work; labour adds the
resource, standard, and control layers around it.

## Verification of prior work (this session)

Every Phase A–F claim was checked directly against the database and the
codebase, not against the previous notes.

Confirmed present in the live database:
- Tables: `wms_operators`, `wms_operator_skills`, `wms_operator_certifications`,
  `wms_task_requirements`, `wms_task_standards`, `wms_labour_time_entries`.
- Views: `wms_labour_queue_view`, `wms_operator_board_view`,
  `wms_operator_utilisation_view`, `wms_operator_productivity_view`.
- Functions: `wms_resolve_labour_standard`, `wms_claim_next_task`,
  `assign_wms_task`, `wms_reassign_task`, `wms_release_task`,
  `wms_set_operator_status`, `wms_set_task_priority`, `wms_operator_clock`,
  `wms_my_operator`, `wms_my_performance`, `wms_log_labour_entry`.

Confirmed present in the codebase:
- `src/features/warehouse/labour/` — operator/queue/standards hooks, operator
  board, queue panel, standards panel, worksheet button, `useMyShift`.
- `src/pages/warehouse/LabourBoard.tsx` control centre;
  `src/pages/warehouse-mobile/MobileMyWork.tsx` routed at `/wm/my-work` and
  linked from the mobile home.
- `labour_worksheet` registered in `generate-document` (fetcher + type map),
  printed through the shared document platform — no bespoke PDF path.
- Realtime task events invalidate the labour queue and board.

Verdict: Phases A–F are genuinely implemented, not superficial. Two defects
found during verification are folded into the work below.

Defects carried forward:
1. `labour_worksheet` maps to the generic `invoice` template in
   `generate-document`; it needs its own worksheet template so the printed
   output is a real task sheet rather than an invoice layout.
2. No planned-availability model exists, so utilisation is measured against
   clocked time only — there is no "should have been staffed" baseline.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| A | Operators as first-class resources | Complete (verified) |
| B | Eligibility-aware assignment | Complete (verified) |
| C | Dimensioned engineered standards | Complete (verified) |
| D | Real-time labour sync | Complete (verified) |
| E | Supervisor Labour Control Centre | Complete (verified) |
| F | Operator mobile surface + labour paperwork | Complete (verified) |
| G | Labour planning & forecasting | Next |
| H | Incentive / performance management | Pending |
| I | Worksheet template + planning paperwork | Pending |

## Phase G — labour planning and forecasting (next)

1. **Shift supply model.** `wms_shift_patterns` (named windows per warehouse:
   start, end, days of week, break minutes) and `wms_operator_shifts`
   (operator × date × pattern, planned/published/cancelled). Grants, RLS and
   `updated_at` triggers follow the existing WMS table conventions.
2. **Demand projection.** `wms_labour_demand(p_warehouse_id, p_from, p_to)`
   converts open and forecast workload — open `wms_tasks`, expected receipts,
   replenishment suggestions, open picks — into required standard seconds per
   warehouse, zone, task type and shift window, using
   `wms_resolve_labour_standard` so no standard is computed client-side.
3. **Supply vs demand view.** `wms_labour_plan_view` joins projected required
   hours to planned operator hours and actual clocked hours, exposing the gap
   per shift window and task type.
4. **Planning UI.** New "Planning" tab on the Labour Control Centre using the
   existing table/chart primitives already in the design system — required vs
   planned vs actual hours, gap highlighting, roster editing per shift, and a
   "publish plan" action. No new charting library, no bespoke Gantt.
5. **Gap alerting.** When a projected gap breaches a configurable threshold,
   emit through the existing warehouse business-event outbox
   (`src/features/warehouse/events`) — not a new notification path.

## Phase H — incentive and performance management (steps 1–2 done)

1. **Done.** `wms_labour_targets` + `wms_resolve_labour_target` — business /
   warehouse / task-type / operator scope, most-specific-wins, date-effective.
2. **Done.** `wms_operator_scorecard(_warehouse_id,_from,_to)` (actual vs target
   performance and utilisation, incentive eligibility) and
   `wms_log_coaching_note` writing into `continuous_feedback`. Surfaced as the
   "Targets & coaching" tab (`LabourPerformancePanel`).
3. **Next.** Payroll hand-off for incentive pay reusing existing payroll input
   pipelines; no parallel earnings path.

## Phase I — paperwork correction (done)

1. **Done.** `labour_worksheet` has its own template type plus operational
   overrides that strip every finance block; `TABLE_MAP` tenancy entries added.
2. **Done.** `labour_roster` document (`fetchLabourRoster`, 14-day window) with
   a "Print roster" action on the Planning tab, via `printDocument`.

## Technical notes

- All new SQL lands as one migration per phase step, each with `CREATE TABLE`
  followed immediately by `GRANT`, then `ENABLE ROW LEVEL SECURITY`, then
  policies.
- Demand and standards resolution stay server-side; hooks only read views and
  call RPCs.
- UI reuses the existing warehouse control-centre shells, table and card
  primitives; no new dashboard framework.

## Instructions for the next agent

1. Resume at Phase H, step 3 (payroll hand-off). A–G and I are shipped.
2. Ship each step whole: schema, RPC, hook, UI, document.
3. Update this file immediately after each step.

