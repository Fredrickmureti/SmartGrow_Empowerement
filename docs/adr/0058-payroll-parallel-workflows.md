# ADR-0058 — Payroll parallel workflows

Status: Accepted · 2026-07-05 · Supersedes the implicit "linear" model in
ADR-0022 / ADR-0036 / ADR-0045 (see addenda in those documents).

## Context

The original payroll module modelled payroll as a single-track lifecycle
where each state (`draft → calculated → approved → posted → paid`) had to
complete before the next could begin. That model matched a small tenant
running one country and one legal entity, but it collapses as soon as any
of the following happens (all of which real customers do):

- The accounting close and the bank-payment run drift apart — Finance
  wants the GL posted on day D, Treasury pays on D+2, and Payroll needs
  to hand statutory certificates to employees on D+1.
- Statutory returns must be prepared and reviewed immediately after
  approval so the tenant can meet a Monday morning filing deadline
  regardless of when Treasury cuts the bank file.
- A run gets reversed for a single employee, correction-run posted, and
  paid separately from the original — the linear model can no longer
  describe which "status" it is in.
- Employees pull P9 / IRP5 / Lohnsteuerbescheinigung certificates the day
  after year-end approval, long before Treasury pays every remittance.

The concrete failure the linear model produced in production was:

- The tax-certificate and statutory-return edge functions refused to
  generate documents until `payroll_runs.status = 'paid'` even though
  every mature enterprise payroll (SAP HCM, SuccessFactors, Workday,
  Oracle HCM Cloud, ADP Workforce Now, Odoo Payroll) generates them from
  **Approval**, not from Payment. Users saw opaque "must be paid" toasts.
- Period close could succeed while GL posting was still pending, because
  the readiness engine only knew about calculation status.

## Decision

Payroll's downstream processes are **peers of Approval, not links in a
chain**. Every downstream workflow is modelled with its own state column
on `payroll_runs`, its own event stream on `business_event_outbox`, and
its own precondition set that reads Approval — never another downstream
workflow.

The six workflows are:

```
                           ┌──── GL Posting ────►  posting_status
                           │
                           ├──── Payment ───────►  payment_status
Payroll Calculation ──►    │
    (status)  ──► Approval ├──── Bank File ─────►  bank_file_status
                (approved_at) │
                           ├──── Payslip Issue ─►  payslip_issuance_status
                           │
                           ├──── Statutory      ─► payroll_return_runs.status
                           │     Returns
                           │
                           └──── Remittances ───► payroll_remittances.status
                                                     ▲
                                                     │  (belongs to Payment,
                                                     │   NOT to Returns —
                                                     │   returns file the
                                                     │   liability; remittance
                                                     │   settles it.)

                                Period Close  ─► payroll_periods.status
                                                (gated by ALL six workflows
                                                 reaching terminal or waived
                                                 states — see Phase 4b.)
```

### Consequences

- `payroll_runs.status` retains only the calculation lifecycle:
  `draft|calculating|calculated|approved|cancelled|reversed`. The legacy
  values `posted` and `paid` are DEPRECATED. New code reads
  `posting_status` / `payment_status` directly. A compatibility view
  `payroll_runs_legacy_status_v` exists to migrate the last few readers.
- The two statutory edge functions (`generate-tax-certificate`,
  `generate-statutory-return`) gate on `payroll_runs.approved_at`, not
  on `status='paid'`. This is enforced by `parallel-workflows-preconditions.test.ts`.
- Period close (`payroll_period_close_atomic`) refuses to advance a
  period when any workflow is outstanding, unless a
  `payroll_period_close_waivers` row covers it or the closer explicitly
  forces with an override reason.
- Every workflow transition writes to `business_event_outbox` so the
  lifecycle timeline can reconstruct exactly who advanced which
  workflow, when, and why — the same audit shape the POS SaleSaga uses.
- The UI presents the six workflows as parallel chips (WorkflowStrip)
  and a per-period matrix (WorkflowMatrix). There is no "next step"
  button because there is no single next step.

## Enterprise inspiration

- **SAP HCM.** RP-CLSTR results feed FI posting, Bank Transfer, and
  year-end forms (Lohnsteuerbescheinigung, W-2) from the same
  `PA-PAYROLL: results table` snapshot without a linear gate.
- **Workday.** "Complete Payroll" is a single Approval event; Post to GL,
  Settlement, and Year-End Tax Forms are peer business processes.
- **Oracle HCM Cloud.** Payroll Flow tasks (Calculate → Verify → Costing
  → Payment → Statutory Reporting) run as peers after Payment
  Distribution is unlocked by Approval.
- **ADP Workforce Now.** Post-approval, Reports, Bank File, Tax Filing
  each have their own status.
- **Odoo Payroll.** Payslip validation snapshots the numbers; posting
  and payment are independent journal entries against the same snapshot.

## Invariants

- No new code may read `payroll_runs.status` for a value outside the
  calculation lifecycle. Enforced by
  `src/test/architecture/no-legacy-payroll-status-reads.test.ts`.
- No downstream workflow may gate on another downstream workflow. Each
  reads Approval + its own state only.
- Certificates and returns become available at Approval, not Payment.
  Enforced by `src/test/payroll/parallel-workflows-preconditions.test.ts`.
- Period close consults `payroll_period_workflow_blockers(period_id)`.
- Business-error responses from the two edge functions use the
  `businessError` envelope (`code`, `message`, `action`, `details`) so
  the UI can render actionable recovery text instead of raw HTTP codes.

## Out of scope

- Country-specific workflow rules (they live in localization packs).
- Off-cycle / retro engine (M-PAY-6, tracked separately).
- Cross-legal-entity consolidation beyond `v_payroll_period_consolidation`.
