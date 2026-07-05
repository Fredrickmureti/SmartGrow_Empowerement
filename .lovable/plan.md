# Return Template Eligibility Audit + UI Precondition Surfacing

## Context

The `generate-statutory-return` 400 you're hitting is the intentional `NO_ELIGIBLE_PAYSLIPS` business error added in the parallel-workflow redesign. The workflow itself is wired correctly:

- Payroll run for April 2026 is `approved_at IS NOT NULL` → passes gate 1.
- Payslips exist but are not in `paid` status → fails the template's `filters.payslip_status = ["paid"]` gate.

The pipeline is doing what an enterprise system should: refusing to emit a cash-basis remittance before cash has moved. The gap is that **(a)** we never audited whether each installed template's filter matches its legal basis, and **(b)** the UI at `/hr/remittances → Returns` does not show the precondition before the user clicks Generate, so the failure feels like a bug.

## What to change

### 1. Template eligibility audit (data / config)

For each row in `localization_pack_return_templates` installed for this org, classify by legal basis and set `filters.payslip_status` accordingly:

| Return type                                  | Correct filter                          |
| -------------------------------------------- | --------------------------------------- |
| PAYE / income tax (accrual, liability-based) | `["approved","validated","paid"]`       |
| NSSF / NHIF / SHIF cash remittances          | `["paid"]`                              |
| SDL / levy monthly returns (KE-style)        | `["approved","validated","paid"]`       |
| Year-end certificates (P9, P10, W-2, etc.)   | `["paid"]` (calendar-year cash basis)   |

Deliverable: one `insert` migration that updates the `filters` JSON on the templates for the currently installed pack, plus a `pack_audit_log` entry per change with the legal-basis rationale.

### 2. Precondition preview in the UI

In `PayrollRemittanceReturns` (the panel at `/hr/remittances → Returns`), before enabling the "Generate" button per template row, call a lightweight `payroll_return_eligibility` view/RPC that returns:

- `approved_runs_count`
- `eligible_payslips_count` (respecting the template's `filters.payslip_status`)
- `blocking_reason` enum (`no_approved_run` | `no_eligible_payslips` | `ready`)

Render:

- `ready` → green "Generate" button.
- `no_eligible_payslips` → amber "Awaiting payment" chip + tooltip listing how many payslips are stuck in which status, with a deep link to the payment batch screen.
- `no_approved_run` → grey "Awaiting approval" chip + link to the run.

This turns the 400 into a preflight state the user sees before clicking, matching how Workday's Tax Filing dashboard and SAP's PC00_M99_URMR surface readiness.

### 3. Business-error contract on the frontend

`useGenerateStatutoryReturn` currently toasts the raw message. Extend it to branch on `error_code`:

- `NO_APPROVED_PAYROLL_RUNS` → toast + CTA "Open payroll run".
- `NO_ELIGIBLE_PAYSLIPS` → toast + CTA "Open payment batches" (pre-filtered to the period).
- `TEMPLATE_NOT_INSTALLED` → toast + CTA "Install localization pack".

### 4. Architecture test

Add `src/test/architecture/return-template-filter-legal-basis.test.ts` that fails if any seeded return template has an empty `filters.payslip_status` or a value inconsistent with its `legal_basis` column. This prevents regression when new packs are installed.

## Out of scope

- Changing the edge function's gating logic — it is correct.
- Auto-triggering payment from the Returns screen — payment remains an explicit peer workflow.
- Retroactively marking April payslips as paid — that is a data action for the user, not something this plan does.

## Verification

1. Apply the template filter audit migration.
2. Reload `/hr/remittances → Returns` for April 2026; PAYE row should now show `ready`, NSSF/NHIF rows should show `Awaiting payment` with counts.
3. Click Generate on PAYE → 200 with a return artifact.
4. Click Generate on NSSF → button is disabled; running the edge function directly still returns the structured 400 (contract preserved for API consumers).
5. `bun vitest run src/test/architecture/return-template-filter-legal-basis.test.ts` passes.
