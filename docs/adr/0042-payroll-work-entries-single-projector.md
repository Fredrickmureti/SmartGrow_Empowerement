# ADR-0042 — Payroll Work Entries: Single Typed Projector

Status: Accepted
Date: 2026-06-29

## Context

`payroll_work_entries` is the projection layer that mediates between the
operational HR modules (Attendance, Leave, Timesheets, Public Holidays,
Overtime) and the payroll computation engine. A Phase 2 architectural
audit found that the table had **two competing writers**:

1. The SQL RPC `attendance_generate_work_entries(_run_id)` invoked from
   the UI ("Sync attendance" button on `PayrollRunList`).
2. The edge function `compute-payroll/index.ts`, which performed its own
   aggregation from raw attendance and then inserted a second, differently
   shaped snapshot row after computing payslips.

Symptoms of the dual-writer architecture:

- Source-vocabulary drift (`'attendance'|'leave'` vs `'attendance'|'timesheet'`).
- The CHECK constraint on `source` did not even include `'timesheet'`,
  so timesheet-driven inserts from the edge function would fail silently
  in `console.warn`.
- `work_entry_type_id` was always NULL, even though the table has a typed
  taxonomy (`payroll_work_entry_types`) and `structureEngine.ts` keys its
  entire aggregation off `work_entry_type_id` — making the typed engine
  effectively dead code.
- Leave was collapsed to a flat `COUNT(*) * 8h` with no respect for the
  employee's schedule, half-days, leave-type pay rules, or unpaid leave.
- Public holidays were only surfaced as a scalar `holiday_hours` column
  written by the edge function; no typed row existed for them.
- Timesheet-driven employees produced zero work entries via the UI button
  (the RPC ignored `contract.time_tracking_source = 'timesheets'`), so
  pre-compute totals shown to operators were wrong.
- `attendance.work_entry_id` was back-filled only on the edge-function
  path, breaking audit trace for rows generated via the UI.

## Decision

There is exactly **one writer** to `payroll_work_entries`:
`public.payroll_work_entries_project(_run_id uuid)`.

This projector:

- Period-locks attendance via `attendance_lock_for_period`.
- Branches per employee on `employee_contracts.time_tracking_source`
  (`attendance` vs `timesheets`).
- Writes typed rows keyed by `work_entry_type_id` resolved against the
  canonical seeded types: `WORK`, `OT`, `LEAVE_PAID`, `LEAVE_UNPAID`,
  `HOLIDAY`, `WORKED_HOLIDAY`.
- Expands leave hours against the employee's `work_schedule_days`, not a
  flat 8h, and resolves paid vs. unpaid via `leave_types.is_paid`.
- Caps overtime by approved `overtime_requests` only when
  `attendance_settings.require_ot_preapproval = true`.
- Back-fills `attendance.work_entry_id` for the audit trail regardless of
  whether the projector is invoked from the UI or the edge function.
- Returns a per-type breakdown `{by_type:{WORK,OT,LEAVE_PAID,…}, sources_used}`.

The canonical types are guaranteed to exist per organization through the
idempotent helper `public.ensure_canonical_work_entry_types(_org_id)`,
which the projector calls on every invocation.

The legacy `attendance_generate_work_entries(_run_id)` is reduced to a
thin forwarder that delegates to the projector and reshapes the response
into the legacy summary. It is scheduled for removal one release after
all callers migrate to the new RPC name.

The `compute-payroll` edge function calls the projector before/after its
own computation instead of writing `payroll_work_entries` rows directly.

## Consequences

- One coherent business definition of what a Work Entry is.
- Every row is typed, enabling `structureEngine.aggregateWorkedHours` to
  drive salary-rule computation from the projection (Stage 3 work).
- Source vocabulary is anchored by a widened CHECK constraint:
  `('attendance','leave','timesheet','holiday','adjustment','manual')`.
- Architectural guards (`payroll_work_entries_projector_contract_test.sql`
  + `src/test/architecture/payroll-work-entries-projector.test.ts`)
  prevent reintroduction of duplicate writers.

## Schedule-driven hour expansion (no hardcoded shift length)

The projector contains **no hardcoded daily-hours constant**. Both Leave
and Public Holiday rows expand hours per employee per date through a
three-step resolution:

1. `work_schedule_days.hours` for the employee's active schedule and the
   row's `day_of_week`.
2. The employee's `work_schedules.standard_hours_per_day`.
3. The organization's default (`is_default = true`) work schedule's
   `standard_hours_per_day`.
4. `0` if none of the above is configured (the row simply is not produced).

This ensures part-time, compressed-week, and non-Mon–Fri schedules are
honoured for both paid leave accrual and statutory holiday hours,
without any per-country or per-organization code change.

## Retired surfaces

- Direct `INSERT INTO payroll_work_entries` from `compute-payroll/index.ts`.
- Per-source ad-hoc aggregation that bypassed the typed taxonomy.
