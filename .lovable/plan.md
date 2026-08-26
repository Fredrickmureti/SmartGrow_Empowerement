# Timesheet Domain — Authoritative Project Status & Roadmap

_Last updated: 2026-08-26. This file is the single source of truth for timesheet-domain
status. Update it after every implementation step._

---

## 1. Completed and verified

| Wave | Scope | Status |
|---|---|---|
| 1 | **Event contract** — `_timesheet_emit_event` in DB, wired into lifecycle functions, timesheet topics registered; approval/rejection are the emitters. | Verified in DB + code |
| 2 | **Billing boundary** — `invoice_project_timesheets` + `resolve_timesheet_billing_rate` server-side; `BillFromTimesheetsDialog.tsx` calls the RPC as one atomic operation; client-side invoice construction deleted. | Verified |
| 3 | **Corrections / immutability** — `correct_timesheet_entry`, `reverse_timesheet_entry`, `_timesheet_can_amend`, `trg_timesheet_correction_supersede`, `tg_prevent_locked_timesheet_mutation`. Approved/locked/invoiced time is amended, never overwritten. | Verified |
| 4 | **Canonical metrics** — `timesheet_effective_settings`, `get_timesheet_employee_metrics`, `get_timesheet_project_metrics`, `get_timesheet_summary`, `get_timesheet_uninvoiced_billable`, canonical/daily/weekly views. `useTimesheetMetrics.ts` is the only metrics reader; `TimesheetReports.tsx` and `ByProject.tsx` both server-only. All temporary `as any` RPC casts removed. | Closed |
| 5 | **Payroll consumer** — `compute-payroll` gate now excludes `superseded` rows (Wave-3 corrections no longer block payroll); org filter added to the hours-override query; function deployed. | Landed, **not yet exercised end to end** |
| 6 | **Access control (partial)** — `_timesheet_is_project_manager` helper + `timesheets_select_project_manager` RLS policy (project-scoped read-only). | Landed, **not yet adversarially tested** |
| 7 | **Attendance boundary** — `v_timesheet_attendance_reconciliation` view (presence vs recorded work), `useTimesheetReconciliation.ts`, reconciliation tab in `TimesheetReports.tsx`. Referential integrity: `_timesheet_block_referenced_delete()` blocks deletion of projects/tasks/employees with non-draft time. | Landed, **not yet exercised end to end** |
| — | **Settings page hang** — `useTimesheetSettings.ts` now always clears `isLoading`; `TimesheetSettings.tsx` renders `DEFAULT_SETTINGS` when the org has no row yet. | Fixed (symptom only) |

---

## 2. Currently active phase

**Phase A — Timesheet Settings surface hardening.** The loading hang is fixed, but the
page has not been audited: it is unknown whether every control is actually wired to a
consumer, and the layout is a flat stack of cards.

---

## 3. Roadmap — tackle strictly in this order

### Phase A — Settings surface: truth audit, then presentation (ACTIVE, do first)

**A1. Control-by-control truth audit.** For every field in `TimesheetSettings.tsx`
(`submission_frequency`, `week_start_day`, `require_project`, `require_task`,
`require_approval`, `default_billable`, `minimum_hours_per_day`,
`maximum_hours_per_day`, `overtime_threshold_daily`, `overtime_threshold_weekly`,
`allow_self_approval`, `block_on_time_off_overlap`), produce a written table with:

- the DB column it writes,
- every runtime consumer (entry form, hook, trigger, RPC, edge function) found by
  grepping the key name across `src/` and `supabase/`,
- whether enforcement is client-only, server-only, or both,
- verdict: **live**, **half-wired** (saved but never read), or **dead**.

Record the table in `docs/timesheets/settings-truth-audit.md`. No control may remain
in the UI with verdict *dead*: either wire it to a real server-side consumer or remove
it. Half-wired controls must gain server enforcement — client-only validation is not
enforcement in an ERP.

Known suspects to check first (do not assume): `submission_frequency` /
`week_start_day` (are period boundaries actually derived from these, or is a hardcoded
Mon–Sun week used in the weekly view and submission grouping?), `minimum_hours_per_day`
(is it enforced anywhere?), and the overtime thresholds (are they consumed by payroll,
or only displayed in reports?).

**A2. Save/feedback correctness.** Verify the save path: optimistic vs refetch,
error surfacing (no silent failures), dirty-state guard on navigation, and that saving
from `DEFAULT_SETTINGS` genuinely inserts the org row (upsert with `organization_id`,
not a blind update). Confirm RLS permits the insert for an admin and refuses it for a
regular employee. Add a disabled/read-only mode for users without settings permission
rather than letting the save fail server-side.

**A3. Presentation and grouping.** Restructure into scoped, scannable sections with
explanatory copy — mirror how mature systems (Odoo *Timesheets → Configuration*,
Harvest, Replicon) group this:

1. **Recording** — what an entry must contain (project/task required, default billable,
   min/max hours per day).
2. **Periods & submission** — frequency, week start, period lock behaviour.
3. **Approval** — approval required, self-approval, approver fallback/escalation.
4. **Overtime** — daily/weekly thresholds and which consumer acts on them.
5. **Conflicts** — time-off overlap, attendance variance tolerance.

Each setting shows a one-line description of its *runtime effect* and where it is
enforced (client / server / both). Use existing design-system tokens and shadcn
patterns only — no hardcoded colours. Sticky save bar showing unsaved-change state.
Follow the scope rules in `docs/settings-source-of-truth.md`: timesheet settings are
org-scoped and are **not** branch-overridable unless a whitelist row is added by
migration.

**A4. Edge-case reasoning (write it down, then implement).** Before coding, reason
explicitly about: part-day and overnight entries; DST transitions and cross-timezone
employees; week boundaries when `week_start_day` changes mid-period; employees hired or
terminated mid-period; retroactive settings changes (must NOT retro-invalidate already
approved/invoiced time — settings resolution must be as-of the entry date, which is what
`timesheet_effective_settings` should provide; verify it does); contractors vs salaried
vs hourly; leave/holiday days; zero-hour and negative-duration guards.

Phase A is done when the audit doc exists, every control is live and server-enforced,
the page is grouped as above, and a Playwright pass confirms each control persists and
changes observable behaviour.

### Phase B — Wave 8: concurrency, idempotency, seeded end-to-end proof (next)

**B1. Concurrency and state guards.**
- Optimistic-concurrency token (`updated_at` or a version column) on entry edit; reject
  edit-while-under-review with a typed error, not a last-write-wins overwrite.
- Duplicate-submission guard: submitting the same period twice must be a no-op, not a
  second `timesheet_submissions` row.
- Approve/reject races: two approvers acting simultaneously — exactly one wins, the
  loser gets a clear conflict error.
- Idempotency keys on `invoice_project_timesheets` so a retried billing call cannot
  double-invoice the same hours; assert the second call returns the first result.

**B2. Seeded scenario data (via migration, org-scoped, clearly marked as seed).**
Hourly employee, salaried project employee, contractor, one billable customer project,
one internal project, one payroll period.

**B3. Scenarios A–J, each executed and evidenced (DB assertions + Playwright where UI
is involved):** A record, B submit, C approve, D reject-and-resubmit, E billable →
invoice, F payroll consumption, G project costing, H correction after approval (and its
downstream effect on an already-issued invoice), I concurrent conflict, J retry with no
duplicate effect. Record pass/fail per scenario in `docs/timesheets/wave8-e2e.md`.

**B4. Adversarial access-control pass** (closes Wave 6): employee cannot read another
employee's entries; project manager sees only their project's time and cannot approve;
payroll/finance read-only; cross-business and cross-branch isolation enforced by RLS,
never by a UI filter. Prove each with a direct query as the wrong actor.

### Phase C — Hardening and closeout

- Attendance-vs-timesheet variance tolerance made configurable (feeds Phase A section 5).
- Performance: index review for the metrics RPCs at 100k+ entries; check `EXPLAIN` on
  the canonical views.
- Final linter/security-scan pass and documentation refresh.

---

## 4. Instructions for the next agent

1. **Verify before you build.** Do not trust section 1 of this file. Re-check each
   "verified" claim against the live database (`supabase--read_query`) and the actual
   source files. Items marked *not yet exercised end to end* (Waves 5, 6, 7) have never
   been proven with real data — treat them as unproven, not done.
2. **No shallow checks.** "The function exists" is not verification. Verification means
   calling it with realistic inputs and asserting the resulting rows, or driving the UI
   with Playwright and reading the outcome.
3. **Where the correct behaviour is unclear, research how mature systems do it**
   (Odoo, SAP CATS, Harvest, Replicon, Workday) and record the chosen precedent and
   rationale in the relevant doc before implementing.
4. **Start at Phase A1** and work strictly in order. Finish each phase to a coherent,
   production-ready state before moving on. No partial features, no orphaned UI, no
   half-wired settings left behind.
5. **Migrations stay small and single-purpose** (one object per migration) — per project
   memory, large batched migrations have destabilised this database.
6. **Update this file after every step**: move completed items into section 1 with the
   evidence used, and advance the "currently active phase" marker.
