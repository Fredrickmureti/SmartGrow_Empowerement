
# Enterprise Payroll Lifecycle Redesign

Reshape payroll from a single linear status machine into a set of **independent workflows** that share one immutable source of truth: an **Approved Payroll Run**. Model this after SAP HCM / Workday / Oracle HCM / D365 — where Payroll Results, Payment, Posting, Statutory Filing, and Period Close each have their own state, owners, and audit trail.

## Guiding principles

1. **Approval = legal immutability boundary.** Once a run is Approved, its calculated results are frozen. Everything downstream reads from that frozen snapshot; nothing downstream can mutate it. Corrections happen via off-cycle / retro runs, never by editing an approved run.
2. **Downstream processes are peers, not a chain.** Payment, GL Posting, Bank File, Statutory Returns, Statutory Remittance, and Period Close each have their own status machine and their own permissions. None of them blocks another except where accounting principle genuinely requires it.
3. **The only hard downstream dependency is on Approval.** Not on payment, not on posting. Statutory Returns and GL Posting depend on Approval; Remittance depends on Return submission + Payment funds availability; Period Close depends on all workflows reaching a terminal state (or being explicitly waived).
4. **Every workflow emits events; UI aggregates state.** No workflow reads another workflow's private status column to decide what it can do. They read the run's `approved_at` and their own state.
5. **Errors are business messages, not HTTP codes.** Every refusal names the workflow, the missing precondition, and the recovery action.

## Target workflow model

```text
                    ┌──────────────────────────────┐
                    │      PAYROLL RUN (facts)     │
                    │  draft → calculated → APPROVED (locked)
                    └──────────────┬───────────────┘
                                   │ approved_at, locked_by
       ┌───────────────┬───────────┼────────────┬──────────────┬───────────────┐
       ▼               ▼           ▼            ▼              ▼               ▼
   Payslip         GL Posting   Bank File   Employee       Statutory        Statutory
   Issuance        (Journal)    Generation  Payment        Return           Remittance
   not_issued →    not_posted → not_gen →   pending →      not_generated →  pending →
   issued →        posted →     generated → partially_paid generated →      partially →
   distributed     reversed     sent        → fully_paid   submitted →      fully_remitted
                                                            accepted
                                   ▼
                         ┌────────────────────┐
                         │  PAYROLL PERIOD    │  open → closing → CLOSED
                         └────────────────────┘
```

Each column above is an **independent lifecycle** with its own table/columns, its own RPCs, its own RLS/permission scope, and its own audit stream. The Batch (ADR-0045) remains the orchestration envelope but stops being a gate.

## What changes

### 1. Data model — split status from workflow states

- Keep `payroll_runs.status` for **calculation lifecycle only**: `draft | calculating | calculated | approved | cancelled | reversed`. Remove downstream meanings ("posted", "paid") from this column over time (backfill + view compat).
- Add per-workflow state on `payroll_runs`:
  - `posting_status` (`not_posted | posted | reversed`) + `posted_at/by`, `posting_je_id`
  - `payment_status` (`pending | partially_paid | fully_paid | on_hold`) + derived from `payroll_payment_batches`
  - `bank_file_status` (`not_generated | generated | sent | acknowledged`)
  - `payslip_issuance_status` (`not_issued | issued | distributed`)
- Statutory workflows live on their own tables (already exist: `payroll_return_runs`, `payroll_remittances`) — remove any join to `payslip.status='paid'`.
- Add `payroll_runs.locked_at / locked_by / lock_reason` (H-PAY-9 already queued) — set on Approval; every mutation trigger checks this instead of status names.

### 2. Approval RPC becomes the "immutability seal"

- `payroll_run_approve(run_id)` (rename/repoint existing approve):
  - Requires maker-checker (already enforced).
  - Stamps `approved_at/by`, `locked_at/by`.
  - Emits `payroll_run.approved` event → downstream workflows become eligible.
  - After this point, the immutability guard trigger blocks every column on `payroll_runs`, `payslips`, `payslip_lines`, `payslip_inputs` except each workflow's own allow-list of columns via `stack_context` bypass.

### 3. Statutory Returns — depend on Approval, not Payment

- `generate-statutory-return` edge fn:
  - Precondition: at least one **approved** run in the period (`approved_at is not null`). Drop any check on payslip `status='paid'` or run `status='posted'`.
  - Template `filters.payslip_status` remains supported but defaults to "all payslips of approved runs".
  - Business error codes:
    - `NO_APPROVED_PAYROLL_RUNS` → "Approve the payroll run for {period} before generating the return."
    - `PERIOD_NOT_YET_APPROVED` when runs exist but none approved.
- `useStatutoryReturns` + `ReturnsTab` already surface structured errors — extend the code list.

### 4. GL Posting — parallel to Payment, not sequential

- `post-payroll-gl` precondition: run is `approved` and `posting_status='not_posted'`. Independent of payment state.
- Reversal path (`reverse-payroll`) unchanged but records event on posting workflow, not on the run's core status.

### 5. Employee Payment — its own object graph

- Payment batches remain the writer; `payment_status` on the run is a **projection** from `payroll_payment_batches` (view/trigger). Never edited directly.
- Partial payments legal: a run can be `fully_paid` for 90% of payslips and `pending` for the remaining 10% (e.g., failed bank record). Model `payslips.payment_status` per-employee and roll up.

### 6. Bank File — independent artifact

- Generation only needs Approval. Sending needs generated. Acknowledgement is a receipt from bank/edge fn. Nothing here touches `payroll_runs.status`.

### 7. Payroll Period Close

- A period `close` RPC checks that each workflow is in a terminal or explicitly-waived state. Waivers are recorded (who/why) so audit is intact. Close writes `fiscal_periods` linkage + emits `payroll_period.closed`.
- Batch lifecycle (ADR-0045) `close` becomes the per-batch equivalent, unchanged.

### 8. UI — Payroll Control Center becomes a workflow board

- Replace the current linear action bar with a **workflow strip** per run showing 6 chips: Calculation · Payslips · Posting · Payment · Returns · Remittance. Each chip:
  - Own status color + last-actor tooltip.
  - Own action menu, enabled purely on that workflow's preconditions.
  - Clicking opens that workflow's drawer (not the run detail).
- Overview shows a matrix: rows = periods, columns = workflows, cells = state. Mirrors Workday's Payroll Processing dashboard.
- Remove any UI text that reads "Pay employees before generating returns" — replace with "Available after Approval".

### 9. Permissions (RBAC per workflow)

Introduce workflow-scoped permissions (build on existing `permission_groups`):
- `payroll.calculate`, `payroll.approve`, `payroll.post_gl`, `payroll.pay`, `payroll.bank_file`, `payroll.returns.generate`, `payroll.returns.submit`, `payroll.remit`, `payroll.period.close`.
Each downstream RPC checks its own permission; SoD framework (mem: sod-self-action) already covers approver ≠ maker.

### 10. Events & audit

- One event per workflow transition into `business_event_outbox` (`payroll_posting.posted`, `payroll_payment.completed`, `payroll_return.generated`, `payroll_return.submitted`, `payroll_remittance.settled`, `payroll_period.closed`).
- `PayslipEventsTimeline` already exists; add sibling `PayrollRunLifecycleTimeline` reading these events.

## Delivery phases

1. **Phase 1 — Immutability seal (foundation).**
   - Add `locked_at/by/lock_reason` + `posting_status` + `payment_status` + `bank_file_status` + `payslip_issuance_status` columns (nullable, backfilled).
   - `payroll_run_approve` stamps lock; immutability guard uses lock, not status label.
   - Views for backwards-compat mapping (`payroll_runs.status` legacy readers).

2. **Phase 2 — Cut Returns & GL loose from Payment.**
   - Rewrite preconditions on `generate-statutory-return` and `post-payroll-gl` to depend only on `approved_at`.
   - New error codes + UI copy in `ReturnsTab` and `PayrollPostingPreviewDialog`.

3. **Phase 3 — Payment projection + Bank File workflow.**
   - `payroll_runs.payment_status` becomes a trigger-maintained projection off `payroll_payment_batches`.
   - New `payroll_bank_files` table (id, run_id, format, generated_at/by, sent_at/by, ack_at, file_ref).

4. **Phase 4 — Period Close + workflow permissions.**
   - `payroll_period_close(period_id)` RPC + waiver table.
   - Split existing `payroll.write` into the 9 workflow permissions; migrate group_rules.

5. **Phase 5 — Control Center UI rebuild.**
   - New workflow strip component + matrix overview.
   - Per-workflow drawers replace monolithic run dialog.
   - Lifecycle timeline for the run (mirrors payslip timeline).

6. **Phase 6 — Retire legacy coupling.**
   - Remove `payroll_runs.status` values that duplicated downstream state (`posted`, `paid`).
   - Update ADR-0045 addendum; write new ADR "Payroll as parallel workflows".
   - Deprecate compat views.

## Technical details

- Column additions ship as one migration per phase; each includes GRANTs + immutability-guard bypass allow-lists per workflow (matches ADR-0045 payment_batch bypass pattern).
- All workflow RPCs `SECURITY INVOKER`, emit outbox events, idempotent on `(run_id, workflow, target_state)`.
- Frontend hooks split: `usePayrollPostingWorkflow`, `usePayrollPaymentWorkflow`, `usePayrollBankFileWorkflow`, `usePayrollReturnsWorkflow`, `usePayrollRemittanceWorkflow`, `usePayrollPeriodClose`. Each returns `{ state, canAdvance, preconditions, actions }`.
- Architecture test: forbid downstream workflow code from reading `payroll_runs.status` — force reads through `approved_at` + workflow's own column.
- No country hardcoding — statutory workflow preconditions continue to derive from `payroll_statutory_rules` + localization packs (invariant from `docs/audit/2026-05-08-payroll-gl-readiness.md`).
- Existing ADRs updated: 0022 (immutability keyed on lock, not status), 0036 (country-agnostic completion — clarify Approval is the completion boundary), 0045 (Batch orchestrates but does not gate downstream workflows).

## Out of scope for this plan

- Off-cycle/retro engine (already queued as M-PAY-6).
- Multi-currency payroll runs.
- Cross-legal-entity consolidation beyond the existing `v_payroll_period_consolidation` view.

## First deliverable if approved

Phase 1 + Phase 2 together — this unblocks the immediate user pain (Returns failing because payslips aren't marked paid) with the correct architectural fix, not a band-aid.
