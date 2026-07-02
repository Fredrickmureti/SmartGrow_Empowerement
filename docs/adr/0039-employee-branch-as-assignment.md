# ADR 0039 — Employee Branch as 0..N Assignment

Status: Accepted (2026-06-28)

## Context

The HR Architecture Review surfaced a fundamental modelling error:
`employees.branch_id` was being used as an ownership column, and the
directory hard-filtered by `branch_id IN (...)` for branch-restricted
users. A previous attempted fix stamped `currentBranch.id` at create time,
which conflated "where the operator was standing in the UI" with "who
owns this person". Symptom: employees became invisible in branches other
than the one in which they were created, and remote / HQ-only / multi-
location staff had no correct representation at all.

Benchmarking against Odoo HR, SAP SuccessFactors, Oracle HCM, Workday and
MS Dynamics 365 HR shows the universal pattern: a Person is owned by a
legal entity, and Branch / Department / Work Location / Position / Manager
are time-bounded **assignments** — not columns on the person.

## Decision

1. **Ownership.** An employee is owned by `organization_id` + `business_id`.
   Branch is **not** ownership.
2. **Branch as 0..N assignment.** A new table
   `employee_branch_assignments(employee_id, branch_id, is_primary,
   effective_from, effective_to, assignment_type, …)` carries the
   relationship. At most one open `is_primary=true` row per employee
   (partial unique index). Employees with zero open assignments are
   HQ/remote and visible to every branch view.
3. **One write surface.** Three SECURITY DEFINER RPCs:
   `assign_employee_to_branch`, `end_employee_branch_assignment`,
   `transfer_employee_primary_branch`. The legacy `transfer_employee`
   RPC delegates branch changes to `transfer_employee_primary_branch`.
4. **Mirror column, guarded.** `employees.branch_id` remains for one
   release as a maintained mirror of the current primary assignment
   (kept in sync by `_eba_sync_primary_to_employees`). Direct UPDATEs
   are rejected by the `_employees_branch_id_write_guard` trigger;
   the maintainer function unlocks the guard with the
   `app.eba_internal_write` session variable.
5. **Canonical read model.** `v_employees_canonical` exposes
   `primary_branch_id` and `branch_ids text[]`. Operational reads use
   these instead of the mirror column.
6. **Visibility contract.** `v_employee_branch_scope` returns one
   `(employee_id, branch_id)` row per open assignment **plus** a synthetic
   `(employee_id, NULL)` row for unassigned employees. RLS for branch-
   restricted users intersects allowed branches with this view (NULL
   matches everyone), so HQ/remote staff are visible in every branch.
7. **Directory behaviour.** The Branch dropdown is a non-destructive
   display filter, never a hard partition. Admins always see the full
   business; restricted users see intersect-or-NULL.

## Consequences

- New scenarios are first-class without schema gymnastics: contractors,
  remote staff, regional managers covering multiple branches, branch
  transfers with history, branch closures without orphans.
- Payroll is unaffected — it was already business-scoped and reads
  `employee_contracts`, never `employees.branch_id`.
- A short-lived mirror column keeps the migration reversible and lets
  long-tail consumers move in their own time, behind the
  `no-direct-employees-branch-write` ESLint rule and the DB trigger.
- One release from now the mirror column drops (Phase E); after that
  `primary_branch_id` is the single source of truth.

## Out of scope

- Cross-business employee mobility (one person across multiple legal
  entities) — separate "global person" model, deliberately deferred.
- Recruitment → Employee promotion (already covered by
  `finalize_employee_draft`).
- Payroll engine internals.
