# Timesheet Domain — Verification Verdict and Continuation (Waves 4–8)

## Phase 1 verification result (checked against the live database and code, not the notes)

Confirmed genuinely landed:

- **Wave 1 (event contract):** `_timesheet_emit_event` exists in the database and is wired into the lifecycle functions; timesheet topics are registered. Approval/rejection are the emitters.
- **Wave 2 (billing boundary):** `invoice_project_timesheets` and `resolve_timesheet_billing_rate` exist server-side, and `BillFromTimesheetsDialog.tsx` now calls the RPC as a single atomic operation — the old client-side invoice-construction path is gone.
- **Wave 3 (corrections):** `correct_timesheet_entry`, `reverse_timesheet_entry`, `_timesheet_can_amend`, `trg_timesheet_correction_supersede` and `tg_prevent_locked_timesheet_mutation` all exist, so approved/locked/invoiced time is amended rather than overwritten.
- **Wave 4 (partial):** the canonical metrics layer exists (`timesheet_effective_settings`, `get_timesheet_employee_metrics`, `get_timesheet_project_metrics`, `get_timesheet_summary`, `get_timesheet_uninvoiced_billable`, canonical/daily/weekly views), `useTimesheetMetrics.ts` exists, and `TimesheetReports.tsx` reads server metrics only.

Confirmed still open (previous notes were accurate here, plus two additions):

- `ByProject.tsx` still loads raw rows through `useTimesheets()` and groups/derives per-project figures in the browser — the last surviving client-side metric engine.
- Generated Supabase types now contain the new RPCs, so the temporary `as any` RPC casts in the metrics hook and billing dialog are no longer needed and should be removed (they currently hide type drift).
- Waves 5–8 (payroll/projects consumers, access control, attendance boundary, concurrency + end-to-end scenarios) are untouched.
- No seeded scenario data exists, so none of the lifecycle claims have ever been exercised end to end.

## Continuation plan

**Wave 4 closure**
- Rewrite `ByProject.tsx` on `useTimesheetMetrics().byProject` (customer, billable flag, uninvoiced billable hours all come from the server), deleting the client grouping and the invoice-gate math.
- Drop the `as any` RPC casts now that types are regenerated; keep inbox counts as a state count of `timesheet_submissions` (a lifecycle count, not a metric) but confirm no dashboard tile recomputes hours.

**Wave 5 — Payroll and Projects consumers**
- Move timesheet consumption out of the legacy `compute-payroll` edge function into a server function reading `v_timesheet_payroll_ready` plus correction events; all payroll math stays in Payroll.
- Verify project costing consumes approved time only, and that closing/archiving a project or task cannot orphan historical entries.

**Wave 6 — Access control and scope**
- Re-derive RLS from the actor model (employee, manager, project manager, payroll officer, finance, admin), adding project-scoped visibility for project managers and read-only access for payroll/finance; confirm business/branch scoping is server-enforced, never UI-filtered.

**Wave 7 — Attendance boundary**
- State the boundary explicitly (Attendance owns presence, Timesheet owns worked/attributed time) and add a reconciliation view (attended vs recorded) instead of a second clock.

**Wave 8 — Concurrency, seeding, end-to-end proof**
- Add optimistic-concurrency/state guards for edit-while-review and duplicate submission.
- Seed a realistic scenario (hourly employee, salaried project employee, contractor, billable customer project, payroll period) via migration and run scenarios A–J: record, submit, approve, reject, billable→invoice, payroll consumption, project costing, correction after approval, concurrent conflict, retry with no duplicate effect.

## Technical notes

- Every wave lands as migration + code change + verification; no half-migrated state, and obsolete implementations are deleted rather than kept as fallbacks.
- Business events remain the only cross-domain contract; consumers stay responsible for their own domain decisions.
