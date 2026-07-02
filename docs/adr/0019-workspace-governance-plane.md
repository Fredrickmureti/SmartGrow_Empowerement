# ADR 0019: Workspace Governance Plane

- **Status**: Accepted
- **Date**: 2026-05-22
- **Supersedes**: n/a
- **Related**: ADR 0016 (Stock Adjustment Immutability), ADR 0017 (GL Balance Sourcing)

## Context

The platform has historically run two control planes that did not know about
each other:

1. **Operational plane** — application-level invariants enforced by Postgres
   row triggers (`enforce_*`, `prevent_*`) designed to refuse mutation of
   business-critical history (posted JEs, approved stock adjustments, locked
   payroll runs, sales orders that have been invoiced, etc.).
2. **Governance plane** — workspace teardown / reset / export operations,
   implemented as `SECURITY DEFINER` RPCs that bulk-`DELETE` historical
   rows.

`SECURITY DEFINER` bypasses RLS, but it does **not** bypass triggers. So
when an org admin clicked "Clear Selected Modules" in `/settings/workspace`,
the governance reset collided head-on with the operational immutability
guards and aborted mid-flight with errors like:

> Stock adjustment line items are frozen once the parent is approved.

The same class of failure existed for ~20 other triggers across payroll,
POS, sales, banking, finance, and org-level invariants.

## Decision

We introduce a recognised **privileged teardown context** that the
operational plane explicitly honours.

- A txn-local GUC `app.reset_in_progress = <organization_id>` is set by
  every governance RPC via `set_config(..., true)`.
- A canonical helper `public._is_teardown_for_org(uuid)` reads the GUC.
- Every operational immutability trigger that fires on UPDATE/DELETE of
  historical rows checks this helper first and short-circuits when set.

This is **not** a bypass. It is a declared, audited, transaction-scoped
governance state. Only `governance.*` `SECURITY DEFINER` functions can set
it, and an architecture test enforces that no application code does.

We also introduce a **registry-driven module model**:

- `public.governance_modules` is the single source of truth describing every
  tenant-scoped module: which tables it owns, which storage prefixes and
  sequences it owns, which derived projections it writes, and the functions
  that preview / teardown / export it.
- `register_governance_module()` is the idempotent upsert RPC used by
  migrations to claim ownership.
- `governance_list_modules()` powers the UI; `governance_list_unowned_tables()`
  powers a CI coverage test that fails when a tenant table is added without
  being claimed.

A **dependency-aware orchestrator** then composes everything:

- `governance_run_teardown(org_id, modules, confirmation, backup_first)`
  validates that the selection is dependency-closed (refuses unsafe partial
  resets that would orphan ledger projections), topologically sorts the
  modules, opens one transaction, sets the teardown context, runs each
  module's `teardown_fn`, and records the result.

A permanent **audit table** `governance_events` records every teardown and
export — its own immutability trigger does NOT honour the teardown context,
so audit history can never be wiped by a future reset.

## Consequences

### Positive
- The original `/settings/workspace?tab=data` failure is fixed end-to-end.
- Adding a new tenant-scoped domain (Payroll, HR, CRM, Projects, Sign, SMS,
  etc.) is now a single migration: `register_governance_module(...)` + a
  `reset_module__<key>` function. The frontend reset tool picks it up
  automatically — drift between hardcoded lists is structurally impossible.
- Unsafe partial selections (e.g. wiping Sales without the transactions
  ledger) are refused at plan time with a human-readable explanation
  instead of an FK error mid-DELETE.
- Workspace exports gain a governance-grade home (`governance_export_jobs`
  + the `governance-exports` storage bucket).

### Negative / risks
- Every immutability trigger now has a 1-line bypass predicate at the top.
  Architecture tests (`teardown-context-guard.test.ts`) enforce that the
  predicate is the canonical one and is present on every required trigger.
- The teardown GUC pattern is foundational — misuse (e.g. setting the GUC
  from application code) would defeat the whole model. Wave 5 adds a Deno
  SQL test that `grep`s `pg_proc.prosrc` to ensure only governance RPCs
  set it.

## Migration Path

- **Wave 1**: bypass on 7 highest-risk triggers (inventory + sales orders
  + JEs + accounts).
- **Wave 2a**: extended to 15 more operational guards (payroll, POS,
  org-level invariants).
- **Wave 2b**: `governance_modules` registry + seeded the 11 existing
  modules.
- **Wave 3**: `governance_run_teardown` orchestrator + immutable
  `governance_events` audit.
- **Wave 4**: `governance_export_jobs` + private `governance-exports`
  storage bucket.
- **Wave 5** (in progress): architecture coverage tests + this ADR.
- **Wave G** (2026-06-10): the payroll immutability cluster
  (`payslips_immutability_guard`, `payslip_lines_immutability_guard`,
  `payroll_runs_immutability_guard`, `payroll_runs_paid_path_guard`,
  `payslips_paid_path_guard`, `payroll_remittances_read_only_guard`) is
  retrofit to honor `_is_teardown_for_org`. This was the last
  operational domain refusing DELETE inside a governance teardown and
  the cause of `platform_delete_organization` failing on tenants with
  posted/paid payroll history. The snapshot in
  `src/test/architecture/teardown-context-guard.test.ts` now lists 29
  guards; the live introspection test
  `supabase/tests/teardown_context_bypass_test.sql` enforces the
  invariant at the DB level. Rule of thumb: **any new immutability
  guard added to a tenant-scoped table MUST honor
  `_is_teardown_for_org` before any other check.**

## Open Items (out of scope)

- Module registrations for Payroll, HR, CRM, Projects, Sign, SMS, Assets
  master, Attendance/Timesheets/Leave, Hardware exec log, Scanner sessions.
  Each becomes a registry insert once its `reset_module__<x>` function
  exists.
- Tenant-level point-in-time restore (requires WAL/PITR strategy).
- Long-term archival storage tiering (S3 Glacier-class).

## Wave G2 — Segregation of Duties (2026-06-11)

The governance plane was extended with a server-enforced Segregation of
Duties (SoD) framework that prevents self-approval and self-benefit
across every sensitive workflow. See `docs/audit/2026-06-11-sod-wave-g2.md`
for the full implementation report.

Key invariants:

1. **Policy registry.** `public.self_action_policy` holds per-org,
   per-action rules with mode `block | warn | require_cosign | allow`.
   Legacy `businesses.payroll_self_approval_policy` is seeded into this
   table and the existing maker/checker trigger now consults it.
2. **One-time overrides.** `public.self_action_overrides` records
   immutable, co-signed, single-use exceptions that expire in 1 hour.
   The helper `governance_assert_not_self` consumes them atomically and
   writes an `audit_logs` event on every allow/deny.
3. **Status-transition triggers.** 17+ tables (`bills`, `payments`,
   `journal_entries`, `purchase_orders`, `expenses`, `employee_loans`,
   `payroll_runs`, `leave_requests`, `stock_adjustments`,
   `stock_transfers`, `timesheet_submissions`, `customer_refunds`,
   `vendor_credit_notes`, `credit_notes`, `employee_compensation_history`,
   `employee_contracts`, `bill_payments`) carry a `BEFORE UPDATE` guard
   that raises `SQLSTATE 42501 / HINT GOV_SELF_ACTION` when an actor
   tries to approve/post their own record (or benefit themselves).
4. **Canonical RPCs.** `approve_bill`, `approve_payment`,
   `approve_journal_entry`, etc. are `SECURITY DEFINER` and delegate the
   SoD check to the trigger (defence in depth).
5. **Approval-rule sanity flag.** `approval_rules.requires_review` is
   set automatically when a user-scoped rule names its own author as
   the static approver — surfaced as a warning, never blocking.
6. **Generic workflow integration.** `approval_history` inserts go
   through the same `governance_assert_not_self` helper so modules
   routing through the generic engine cannot bypass the guard.

**Rule of thumb:** any new transactional table that gains an
`approved_by` column MUST also register a status-transition guard and
appear in `src/test/architecture/sod-coverage.test.ts`. The pgTAP
fixture `supabase/tests/self_action_guard_test.sql` enforces the
runtime invariant.
