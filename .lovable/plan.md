# Enterprise Warehouse Labour Management (WLM) — Implementation Plan

Authoritative status document. Update it after every implementation step.

## Vision

Labour is a managed resource, not a report. The system must know who is
available, what they are qualified to do, what the work *should* take, what it
actually took, and what to do when reality diverges. One task engine
(`wms_tasks`, ADR 0101) remains the single source of work; labour adds the
resource, standard, and control layers around it.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| A | Operators as first-class resources (`wms_operators`, skills, certifications, task requirements) | Complete |
| B | Eligibility-aware assignment (claim/assign enforce skills, certs, workload) | Complete |
| C | Dimensioned engineered standards (warehouse / zone / category / equipment; setup + handle + travel) | Complete |
| D | Real-time labour sync (task events invalidate queue + board) | Complete |
| E | Supervisor Labour Control Centre (roster, queue, standards, intervention RPCs) | Complete |
| F | Operator mobile surface + labour paperwork | Complete |
| G | Labour planning & forecasting (demand → required hours → roster gap) | Not started — next |
| H | Incentive / performance management (goal setting, coaching, payroll hand-off) | Not started |

**Currently active phase: G (not yet started).**

## Completed and verified

### Phase A/B/C — data and logic (migrations `20260803195252`, `20260803195500`)
- `wms_operators`, `wms_operator_skills`, `wms_operator_certifications`,
  `wms_task_requirements` with grants, RLS and updated_at triggers.
- `wms_task_standards` extended with `warehouse_id`, `zone_id`,
  `product_category_id`, `equipment_class`, `setup_seconds`,
  `travel_seconds_per_metre`.
- `wms_resolve_labour_standard` — most-specific-wins resolution; used by the
  earned-seconds trigger so standards are never computed client-side.
- `wms_claim_next_task` and `assign_wms_task` enforce eligibility,
  certification validity and concurrent-task limits.
- `wms_labour_time_entries` + `wms_operator_utilisation_view` (direct +
  indirect + idle → true utilisation).
- Supervisor RPCs: `wms_reassign_task`, `wms_release_task`,
  `wms_set_operator_status`, `wms_set_task_priority`.

### Phase D/E — supervisor control centre
- `src/features/warehouse/labour/useLabourOperators.ts` — roster, skills,
  certifications, status.
- `src/features/warehouse/labour/useLabourQueue.ts` — queue view, supervisor
  RPC wrappers, utilisation.
- `OperatorDialog.tsx`, `OperatorBoard.tsx`, `LabourQueuePanel.tsx`,
  `StandardsPanel.tsx`.
- `src/pages/warehouse/LabourBoard.tsx` rebuilt as a tabbed control centre
  (on-shift count, true utilisation, performance).
- `useWmsRealtimeSync.ts` invalidates labour queue + board on task events.

### Phase F — operator surface and paperwork (migration: WLM Phase F)
- Shift clock RPCs: `wms_operator_clock` (off_shift / on_shift / break),
  `wms_my_operator`, `wms_my_performance`, `wms_log_labour_entry`.
- Idle/break time is opened and closed exclusively by status transitions
  (`_wms_labour_open` / `_wms_labour_close_open`), so overlapping entries are
  structurally impossible.
- `trg_wms_operator_activity_sync` on `wms_tasks` flips the operator to
  `executing` (closing idle) when work is in hand and back to `on_shift`
  (reopening idle) when the last task closes.
- Clocking off or taking a break is refused while tasks are still held.
- `src/features/warehouse/labour/useMyShift.ts` — self-scoped hooks
  (operator, open tasks, performance, clock / claim-next / log-indirect).
- `src/pages/warehouse-mobile/MobileMyWork.tsx` at `/wm/my-work`, linked from
  the mobile home; clock controls, eligibility-aware "Claim next task",
  open-task list, today's earned/clocked/performance, indirect-time capture.
- `labour_worksheet` document type registered in `generate-document`
  (fetcher + template map) and printed via `printDocument` from
  `LabourWorksheetButton` on the operator board. Read model only.

Verification performed: full TypeScript typecheck clean; migration applied
successfully; new RPCs present in generated Supabase types.

## Pending work

### Phase G — labour planning and forecasting (next)
1. `wms_labour_demand` projection: convert open/forecast workload (orders,
   receipts, replenishment) into required standard hours per warehouse, zone
   and task type per shift window.
2. `wms_shift_patterns` / `wms_operator_shifts`: planned availability per
   operator so supply can be compared with demand.
3. Planning view on the Labour Control Centre: required vs. planned vs.
   actual hours, gap highlighting, and a "publish plan" action.
4. Alerting when the projected gap breaches a threshold, reusing the existing
   business event outbox rather than a new notification path.

### Phase H — incentive and performance management
1. Goal/target management per operator and task type.
2. Coaching records tied to `continuous_feedback`.
3. Payroll hand-off for incentive pay (must reuse existing payroll input
   pipelines; do not create a parallel earnings path).

## Instructions for the next agent
Phase I is closed out (dedicated labour worksheet/roster templates, roster fetcher deployed, Print roster on the Planning tab) and Phase H steps 1–2 are in: date-effective wms_labour_targets with most-specific-wins resolution, a server-side operator scorecard with variance and incentive eligibility, and coaching notes written into the existing employee feedback record — surfaced as a new Targets & coaching tab. Next up is the payroll hand-off for incentive pay.

