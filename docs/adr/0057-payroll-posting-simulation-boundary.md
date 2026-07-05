# ADR: Payroll Posting Simulation Boundary

Status: Accepted
Date: 2026-07-05

## Context

The payroll module supports two related but distinct operations against
the general ledger:

1. **Post payroll to GL** — the accounting event that creates the
   balanced journal entry, transitions the run `approved → posted`,
   writes `payroll_liabilities`, and records `audit_logs.action =
   'gl_posted'`. This is the ONLY operation that mutates accounting
   state for a run.
2. **Preview posting** — an accountant-facing projection that answers
   *"what JE would this run produce right now?"*. It must be safe to
   run at any pre-post stage and must NEVER mutate accounting state.

An enterprise-architecture audit revealed that our implementation of
these two operations was structurally conflated. The `post-payroll-gl`
edge function served both via a `dry_run` flag, but three write-path
controls executed **before** the `dry_run` branch:

- The Segregation-of-Duties helper `user_can_post_payroll`, which
  requires `status = 'approved'` and prevents the creator/approver
  from also posting.
- The idempotency short-circuit that returns
  `{ already_posted: true, journal_entry_id }` when a non-voided JE
  already exists for the run.
- The closed-fiscal-period hard-fail.

Combined with a "Simulate posting" button placed on the *GL Account
Mapping* configuration screen — which auto-selected "the latest
draft/computed run" rather than binding to a specific run — the visible
symptom was:

> *Simulate → toast says complete → run still Draft → Approve → Post
> → "already posted"*

The preview and the real post shared the same idempotency response, so
if any prior test/attempt had left a JE for that run, both operations
returned the same `already_posted` payload and looked identical to the
accountant.

## Decision

Establish an explicit boundary between preview and post, aligned with
SAP HCM, Workday, Oracle Fusion HCM, Dynamics 365 F&O, Odoo and Sage:

```text
 draft ─► computed ─► approved ─────► posted ─► paid ─► remitted ─► closed
                       │                ▲
                       └── preview ─────┘   (read-only, run-scoped)
```

### Rules

1. **Preview is a pure projection of `(run, mappings, pack, period)`.**
   It never short-circuits on existing-JE, SoD, or closed-period. Those
   conditions become fields on the preview payload
   (`already_posted`, `existing_journal_entry_id`, `warnings[]`) so the
   UI can render them as read-only badges/warnings without conflating
   them with the write outcome.
2. **Preview is run-scoped.** The user (or a row action) picks the
   specific run; no auto-selection of "the latest draft". Preview lives
   on the payroll run — inside `PayrollRunDetailsDialog` — not on the
   mapping configuration page.
3. **Post is the sole writer** and requires an explicit state
   precondition `payrollRun.status === 'approved'` inside
   `post-payroll-gl`, in addition to the existing SoD, mapping-role
   validation, and period-lock checks. This makes `posted` reachable
   from exactly one prior state and prevents any code path from silently
   jumping states.
4. **Preview has non-financial audit provenance.** Every dry-run writes
   one `audit_logs` row with `action = 'payroll_posting_previewed'`.
   No `journal_entries`, `payroll_runs.status`, `payroll_liabilities`,
   or `payroll_liability_sources` rows are ever created on the preview
   path.

## Consequences

- The `PayrollPostingSimulator` component (and its "latest-run"
  auto-selection) is removed. `PayrollPostingPreviewDialog(runId)`
  replaces it and is mounted next to the "Post to GL" button on each
  run.
- `post-payroll-gl` now returns two distinct response shapes:
  - Preview: `{ dry_run: true, lines, total_debits, total_credits,
    balanced, warnings, already_posted, existing_journal_entry_id,
    run_status, employee_count }`.
  - Post: unchanged (`{ journal_entry_id, journal_entry_number,
    total_debits, total_credits, line_count, liabilities_created }`)
    plus a new `{ error: 'invalid_state', current_status,
    required_status }` when the run is not `approved`.
- Architecture guards live in
  `src/test/architecture/post-payroll-gl-simulation-boundary.test.ts`
  and lock every invariant above.
- The DB unique index `idx_journal_entries_source_unique` already
  enforces "one non-voided JE per `(org, source_type, source_id)`",
  so no schema change is required to guarantee single-post idempotency.

## Alternatives considered

- **A dedicated `preview-payroll-gl` edge function.** Rejected because
  preview and post must project the exact same JE — duplicating the
  builder would immediately drift. The single-function-with-guarded-
  `dry_run` pattern keeps the projection code identical while making
  the boundary structural (an early return before any mutation).
- **A database-level `posted`-only trigger on `payroll_runs`.** Not
  added in this change; `payroll_runs` already carries multiple state
  guards (`payroll_runs_paid_path_guard`,
  `payroll_runs_immutability_guard`,
  `enforce_payroll_maker_checker`) and the explicit application-level
  precondition combined with the JE unique index is sufficient. A DB
  transition trigger remains available as a follow-up if further
  jump-state defects are ever observed.
