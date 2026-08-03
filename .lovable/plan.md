# Warehouse Labour Management — Verification Result and Final Phase (H.3)

## Verification of the previous engineer's claims (done this session)

Every claim was checked against the live database and the codebase, not the notes.

Confirmed present in the database:
- Standards/eligibility layer: `wms_resolve_labour_standard`, `wms_claim_next_task`,
  `assign_wms_task`, `wms_reassign_task`, `wms_release_task`, `wms_set_operator_status`,
  `wms_set_task_priority`.
- Operator shift layer: `wms_operator_clock`, `wms_my_operator`, `wms_my_performance`,
  `wms_log_labour_entry`, `_wms_labour_open` / `_wms_labour_close_open`.
- Planning layer (Phase G): `wms_labour_demand`, `wms_labour_plan`, `wms_publish_labour_plan`.
- Performance layer (Phase H.1–H.2): `wms_resolve_labour_target`,
  `wms_operator_scorecard`, `wms_log_coaching_note`.

Confirmed present in the codebase: `LabourPlanningPanel`, `LabourPerformancePanel`,
`LabourQueuePanel`, `StandardsPanel`, `OperatorBoard`, `LabourRosterButton`,
`LabourWorksheetButton`, plus the matching hooks, and `labour_worksheet` /
`labour_roster` registered in the shared `generate-document` platform.

Verdict: Phases A–G and I are genuinely implemented; Phase H steps 1–2 are
genuinely implemented. Only the incentive payroll hand-off (H.3) remains.

## What the remaining phase actually has to solve

The prior notes said "reuse existing payroll input pipelines". Investigation shows
those pipelines are not persisted, which changes the design:

- `payroll_input_types` declares the per-run input slots a localization pack allows.
- Variable earnings are held as transient React state in the payroll create dialog
  and passed straight into `compute-payroll` at run creation.
- `payslip_inputs` is written by the engine *after* computation as provenance keyed
  to a payslip — it is not an inbox a warehouse could post into.

So there is no persisted place for a pre-run input to wait. Warehouse incentive pay
must land in a persisted, payroll-owned staging store that the existing create-run
flow reads, rather than a warehouse-only earnings path.

## Phase H.3 — incentive pay hand-off

1. **Payroll-owned staging table** `payroll_pending_inputs`
   (org, business, employee, `code` matching a `payroll_input_types.code`, quantity,
   amount, uom, period window, `source_kind` + `source_id` for provenance, status
   `pending` / `consumed` / `cancelled`, consumed run id, timestamps).
   Grants, RLS scoped to business membership, and an `updated_at` trigger.
   This is a payroll-domain object, not a WMS one: any module can post to it.

2. **Warehouse producer RPC** `wms_post_incentive_inputs(warehouse, from, to, code)`
   — reads `wms_operator_scorecard` for the window, keeps only operators flagged
   `incentive_eligible`, resolves each operator to its employee, computes the
   incentive amount from the resolved target (earned vs target performance), and
   inserts one `pending` row per employee. Idempotent per
   (employee, code, window, source) so re-running cannot double-pay. No earnings
   maths in the browser.

3. **Payroll consumption** — the create-run flow prefills its variable-earnings
   state from `payroll_pending_inputs` for the selected period (grouped by code,
   only codes the active structure permits), shows them as pre-populated and
   overridable, and marks the rows `consumed` with the run id once the run is
   created. Reversal/cancel of a run releases them back to `pending`.

4. **Warehouse UI** — an action on the existing "Targets & coaching" tab that posts
   the window's incentive inputs and reports what was staged. Reuses the panel,
   table and dialog primitives already in the tab; no new dashboard, chart or
   bespoke grid.

5. **Guards** — an architecture test asserting nothing in `src/features/warehouse`
   writes payslip/earnings tables directly, so the only route from labour
   performance to pay stays this staging table.

## Defect to fix first (blocking the build)

`src/features/warehouse/labour/useLabourPerformance.ts` (line 125) destructures
`organization` from `useOrganization()`, which exposes `currentOrg`. This is a
typecheck failure left by the previous engineer, so the target-save path was never
compiled. Fix: use `currentOrg` and reference `currentOrg?.id` when stamping
`organization_id`.

## Additional gaps appended to the plan (found during verification)


- **Consumption audit trail.** Every incentive row records the scorecard window and
  target version used, so a paid figure can be re-derived later.
- **Period safety.** Posting is refused when the target payroll period is closed or
  locked, reusing the existing fiscal/period lock checks rather than a new one.

## Technical notes

- One migration for the table, one for the producer RPC; `CREATE TABLE` → `GRANT`
  → `ENABLE ROW LEVEL SECURITY` → policies, in that order.
- All amount computation stays server-side in SQL; hooks only call RPCs and read.
- Documents continue through `printDocument` / `generate-document`.

## Instructions for the next agent

1. A–G, I and H.1–H.2 are shipped and verified. Start at H.3, step 1.
2. Ship each step whole: schema, RPC, hook, UI, guard test.
3. Update this file immediately after each step.
