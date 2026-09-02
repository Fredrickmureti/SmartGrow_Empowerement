# Microfinance convergence — live status (2026-09-02, later)

Plan of record: `.lovable/plan/smart-grow-empowerment-microfinance-convergence-plan-reworke-2026-09-02.md`

Done: C1–C8b. **V1 live lifecycle proof: PASS.**

## V1 result (verified against the live database)

One client → application (draft → submitted → under_review → assessment →
approved → ready_for_disbursement) → loan + 4-installment schedule →
disbursement → partial repayment → second repayment → reversal → top-up →
successor disbursement → predecessor closure.

- events posted: `loan_disbursed`, `repayment_recorded` x2,
  `repayment_reversed`, successor `loan_disbursed`,
  `loan_settled_by_successor` (non-financial events `loan_created`,
  `loan_topped_up` correctly not posted).
- `unbalanced_entries`: **none** — every generated journal entry balances.
- reversal produced a contra entry, no edit of the original.
- predecessor `LN-000001` → `closed`, successor `LN-000002` → `active`
  (principal 63,480 = 43,480 outstanding + 20,000 top-up... verified as
  outstanding principal carried + additional principal).

### Defects fixed to get here (this pass)

1. `_mf_application_guard` had no `ready_for_disbursement → disbursed`
   transition, so no disbursement could ever complete.
2. `mf_apps_status_chk` did not allow the `disbursed` value at all.
3. `mf_loans.application_id` was NOT NULL, so top-up/restructure successors
   (which derive from a loan, not a new application) could not be created.
   Now nullable with `CHECK (application_id IS NOT NULL OR parent_loan_id IS NOT NULL)`.

Temporary helpers `__v1_lifecycle_proof`, `__v1_probe_disburse` and the
results table have been dropped. The V1 proof rows (client `V1-CLI-001`,
loans `LN-000001/2`) remain — financial history is deliberately
non-deletable; they are dev data in an otherwise empty lending domain.

## Next: C9 — reports & documents on the inherited engines

No new renderer, no new PDF path. Register microfinance report and document
definitions into the existing engines with institution settings injected.
Then C10 (hardening + the single bulk ERP removal sweep). The ~3,675
inherited linter findings stay deferred to C10 as planned — none of them
originate in `mf_*`.
