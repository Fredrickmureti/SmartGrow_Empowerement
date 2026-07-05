# ADR-0058 addenda (parallel workflows) — cross-references

Status: Accepted · 2026-07-05 · Companion to `0058-payroll-parallel-workflows.md`.

The following prior ADRs pre-date the parallel-workflows model and MUST be
read together with ADR-0058. This file records the addendum text so each
original ADR does not have to be rewritten.

## Addendum to ADR-0022 (Payroll mapping integrity)

Immutability of a payroll run is keyed on `locked_at`, **not** on any
particular `status` label. Once `locked_at` is set, only the columns
explicitly allow-listed for a specific downstream workflow may be
written (posting workflow may write `posting_*` columns, payment
workflow may write `payment_*` columns, etc.). This preserves the ADR-0022
"one snapshot, many consumers" guarantee while allowing the six workflows
of ADR-0058 to advance independently.

## Addendum to ADR-0036 (Country-agnostic payroll completion)

The "completion" boundary for statutory certificates and returns is
**Approval** (`payroll_runs.approved_at IS NOT NULL`), never Payment or
GL Posting. `generate-tax-certificate` and `generate-statutory-return`
enforce this via the `NO_APPROVED_PAYROLL_RUNS` business error. Missing
localization pack templates surface as the `TEMPLATE_NOT_INSTALLED`
business error with a recovery hint pointing at Settings → Localization →
Packs; edge functions never return a bare 404/500 for a predictable
business condition.

## Addendum to ADR-0045 (Payroll batches control record)

A payroll batch orchestrates run creation and grouping. It does **not**
gate downstream workflows. Batch state describes which runs the batch
owns and what the batch's own consolidation status is, not the posting,
payment, bank-file, returns, or remittance state of its runs — those live
on the individual run's workflow-state columns and are consumed via the
Phase 5 workflow hooks (`usePayrollPostingWorkflow`, etc.).

## Addendum to ADR-0036-addendum (Tax certificate lifecycle)

Certificate provenance (`provenance = { run_ids, max_committed_at,
max_correction_at, ytd_rollup_hash }`) is computed from **approved** runs
only. A run that has been posted or paid but not approved must never
contribute to a certificate. This preserves the ADR-0036 audit trail
under the ADR-0058 parallel-workflow model.
