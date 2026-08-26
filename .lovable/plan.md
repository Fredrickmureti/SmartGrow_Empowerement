# Timesheet Domain — Architecture Audit Findings and Re-engineering Waves

## What the investigation found (verified against the live database and code)

The Timesheet domain already exists and is more mature than a CRUD screen: the database enforces most of the lifecycle server-side. The problems are not "missing features" — they are **ownership leaks, a duplicated billing path, a half-built correction model, and no event contract**.

Verified facts:

- Tables: `timesheets` (34 cols, the time-entry grain), `timesheet_submissions` (period + approval grain), `timesheet_settings` (per-org rules), `timesheet_audit_log`, plus a payroll-facing view `v_timesheet_payroll_ready`. All four tables currently hold **0 rows** — nothing is in production use yet, so restructuring is low-risk.
- Server authority mostly exists: `submit_timesheet_period`, `approve_timesheet_submission`, `reject_timesheet_submission`, a real state machine trigger (`draft → submitted → approved/rejected → locked`, `locked` terminal), self-approval guard, employee-active guard, project-eligibility guard, period guard, payroll lock guard, audit trigger, cost trigger.
- RLS is on all timesheet tables with self / manager / module-permission split — self can only edit `draft`/`rejected`.
- Payroll consumes correctly in principle: `compute-payroll` reads `v_timesheet_payroll_ready` (approved+locked only) and **blocks** the run when a timesheet-driven contract has non-approved rows. Payroll math stays in Payroll.

Confirmed defects:

1. **Two competing billing paths.** An authoritative RPC `invoice_project_timesheets` exists (advisory lock, row claiming, permission check), but the UI (`src/components/timesheets/BillFromTimesheetsDialog.tsx`) ignores it: it reads billable rows in the browser, groups and prices them client-side, calls `createInvoice`, then calls `mark_timesheets_invoiced`. This is client-authoritative billing and non-atomic — invoice created, marking can fail, hours get double-billed.
2. **Timesheet owns sales pricing.** `timesheets.billing_rate` / `billing_amount` are computed by a timesheet trigger, and the dialog re-derives line prices from them. Rate resolution and invoice pricing belong to Sales/Projects; Timesheet should own hours and billable classification only.
3. **Corrections are half-built.** `timesheets.correction_of` exists but there is **no correction/reversal RPC anywhere** — so approved/locked time can only be edited or blocked, never amended with history preserved.
4. **No business-event contract.** No timesheet function writes to `business_event_outbox`; downstream domains poll tables/views instead of consuming events. Retry/idempotency semantics are undefined for approval and billing.
5. **Reports re-implement business rules.** `TimesheetReports.tsx` recomputes overtime/billable/utilization in the browser from raw rows + settings — a second, divergent definition of the same metrics.
6. **Payroll integration lives in a legacy Edge Function** (`compute-payroll`), while this stack's server layer is TanStack server functions; the consumer is correct but architecturally misplaced.
7. **Attendance boundary unverified in code** — `attendance` and `timesheets` are separate tables (good), but nothing prevents the same worked hours existing in both with no reconciliation definition.

## Canonical ownership to be enforced

- **Timesheet owns:** time entries, hours, date, employee attribution, project/task attribution, billable classification, submission & approval state, approval history, periods, corrections, audit.
- **Timesheet does not own:** billing rates/prices/invoices (Sales), payroll amounts/overtime pay/statutory (Payroll), project/task master data and budgets (Projects), journal entries (Finance), presence/clock events (Attendance), metric definitions in reports (canonical DB views).

## Waves

Each wave is a migration + code change + scenario verification. Waves land in order; nothing is left half-migrated.

**Wave 1 — Event contract and idempotency.** Register timesheet topics (`timesheet.submitted`, `.approved`, `.rejected`, `.corrected`, `.locked`, `.billable_ready`) in `business_event_topics`; emit from the existing RPCs/triggers into `business_event_outbox` with a deterministic idempotency key. Approval/rejection become the only emitters.

**Wave 2 — Billing boundary.** Make `invoice_project_timesheets` (or a submission-scoped equivalent) the single billing entry point; rewrite `BillFromTimesheetsDialog` to preview and then call that RPC only. Delete the client-side invoice-construction path and `mark_timesheets_invoiced` as a public step. Move rate resolution to a Projects/Sales-owned resolver; keep the resolved rate on the timesheet only as a non-authoritative snapshot.

**Wave 3 — Correction and immutability model.** Add `correct_timesheet_entry` / `reverse_timesheet_entry` RPCs using `correction_of`: approved or payroll-locked or invoiced time is never mutated in place — a correction row is created, original stays as historical fact, and a `timesheet.corrected` event notifies Payroll/Billing/Projects consumers. Tighten the mutation guards so no path can edit a locked/invoiced row.

**Wave 4 — Canonical metrics.** Create authoritative views/functions for total, approved, billable, non-billable, overtime, payable and utilization hours (driven by `timesheet_settings` server-side). Rewrite `TimesheetReports.tsx`, `ByProject.tsx` and dashboard/inbox counts to read those views; delete client-side metric math.

**Wave 5 — Payroll and Projects consumers.** Move the timesheet-consumption part of payroll off the Edge Function onto a server function consuming `v_timesheet_payroll_ready` plus the correction events; keep all payroll calculation in Payroll. Verify project costing consumes approved time only and that closing/archiving a task or project cannot orphan historical entries.

**Wave 6 — Access control and scope hardening.** Re-derive the RLS policies from the actor model (employee, manager, project manager, payroll officer, finance, admin), including project-scoped visibility for project managers and read-only access for payroll/finance. Ensure branch/business/tenant scoping is enforced server-side, never by UI filtering.

**Wave 7 — Attendance boundary.** Define explicitly that Attendance owns presence and Timesheet owns worked/attributed time; add a reconciliation view (attended vs recorded) instead of a second clock. No duplicate source of truth.

**Wave 8 — Concurrency, seeding and end-to-end verification.** Add optimistic-concurrency/state guards for edit-while-review and duplicate submission; seed a realistic scenario (hourly employee, salaried project employee, contractor, billable project with customer, payroll period) and run scenarios A–J: record, submit, approve, reject, billable→invoice, payroll consumption, project costing, correction after approval, concurrent conflict, retry with no duplicate effects.

## Technical notes

- All lifecycle changes go through `supabase--migration`; RPCs stay `SECURITY DEFINER` with `search_path = public` and explicit permission checks, matching the existing `user_has_module_permission` pattern.
- New app-server logic uses `createServerFn`, not new Supabase Edge Functions.
- Obsolete paths (client-side invoice construction, client metric math, superseded RPC arguments) are deleted at the end of their wave — no silent fallbacks.


====================================PROGESS================
I got Wave 4 partly landed before stopping. Here's the exact state:

Done and applied

Migration (successful): canonical metrics layer in the database — timesheet_effective_settings() (business-over-org settings resolution, 8h/day and 40h/week fallbacks), views v_timesheet_entry_canonical (excludes superseded corrections), v_timesheet_daily_metrics, v_timesheet_weekly_metrics, and report functions get_timesheet_employee_metrics, get_timesheet_project_metrics, get_timesheet_summary, get_timesheet_uninvoiced_billable. All security-invoker/RLS-respecting; a follow-up migration revoked anon/PUBLIC execute on the settings helper (linter count dropped accordingly; all remaining linter items are pre-existing project-wide).
src/hooks/timesheets/useTimesheetMetrics.ts (new) + exported from src/hooks/timesheets/index.ts.
src/pages/timesheets/TimesheetReports.tsx rewritten to read only the server metrics — no client-side overtime/billable/utilisation math left.
Remaining in Wave 4 (next agent)

Rewrite src/pages/timesheets/ByProject.tsx to use useTimesheetMetrics().byProject (it exposes customer_id, project_is_billable, uninvoiced_billable_hours — so the "Invoice" gate and the open-billable column no longer need client grouping via useTimesheets/useProjects).
Point dashboard/inbox counts (useTimesheetInboxCounts) and any HR dashboard tiles at the canonical summary rather than raw rows.
Run a typecheck (tsgo) — the new RPCs are not in src/integrations/supabase/types.ts yet (types regeneration timed out), hence the as any RPC casts; re-verify after the types refresh.
Smoke-verify each RPC returns rows once seed data exists, then update .lovable/plan.md: Waves 1–3 complete/verified, Wave 4 active (DB + Reports done, ByProject/dashboards pending), Wave 5 (payroll/projects consumers) next.

 verify the Wave 1–3 migrations and this Wave 4 layer against enterprise standards before resuming at the remaining Wave 4 items.