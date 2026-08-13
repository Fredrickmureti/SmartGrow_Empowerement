# Expense Management — Phase 7 verification verdict, then Phase 8 (settlement UX & remaining hardening)

## Phase 1 — Verification of the previous engineer's claims

I checked the live database and the code, not the log.

| Claim (Phases 1-7) | Verdict | Evidence |
|---|---|---|
| Payer-first capture ("Who paid?" first) | Confirmed | `ExpenseFormFields.tsx` opens with a "Who paid?" section; employee picker only for `paid_by='employee'`, paid-from account only for `paid_by='company'` |
| Create/edit wiring for payer + employee | Confirmed | `ExpenseCreatePage.tsx`, `ExpenseEditPage.tsx` both map and hydrate `paid_by`/`employee_id` |
| Server-owned lifecycle rendered as a timeline | Confirmed | `expenseView.tsx` renders `submitted_at`, `approved_at`, `reimbursed_at`, `voided_at` and the GL-posted entry |
| Browser cannot author state at INSERT or UPDATE | Confirmed with one exception | `status`, `base_amount`, `exchange_rate`, `tax_amount`, `expense_number`, `journal_entry_id`, `approved_at`, `reimbursed_at` are all `false` for both INSERT and UPDATE. **Exception:** `reimburse_via_payroll` still has INSERT privilege — a client can pre-flag an expense for payroll reimbursement at creation, bypassing `expense_queue_payroll_reimbursement` and its eligibility guard |
| Architecture ratchet green | Confirmed, but narrow | `expense-domain-ownership.test.ts` inspects `.from("expenses")` chains for server-owned columns, but does not distinguish INSERT payloads, so the newly revoked insert columns are not ratcheted |
| Settlement surfaced in the UI | Partially — as the log itself states | "Reimburse employee" / "Remove from payroll queue" exist only in the list row menu (`src/pages/Expenses.tsx`). `ExpensePeekSheet` exposes only "Void expense"; neither peek nor the record projection shows *which* route discharged a reimbursement |

Verdict: Phases 1-7 are genuinely implemented; no claim was superficial. Pending work is exactly Phase 8 plus the two hardening gaps above.

## Phase 8 — Settlement UX for employee reimbursements

Presentation and guard work only. No new engine, no new lifecycle state, no direct table writes; the Phase 1-6 RPCs and RLS remain the contract.

**8A. Settlement affordance on the peek and record surfaces**
- Add a `useExpenseSettlement` helper deriving, from the record already loaded by `useExpenseView`, whether an expense is settleable: approved-or-paid, `paid_by='employee'`, an `employee_id` present, not already reimbursed, no owning bill.
- `ExpensePeekSheet` gains the same two actions the list row menu has — "Reimburse employee" (opens `ExpenseReimburseDialog`) and "Remove from payroll queue" — alongside the existing "Void expense", gated by that helper. The dialog stays the single input collector for `expense_reimburse_direct` / `expense_queue_payroll_reimbursement`.
- The settlement affordance is rendered from the same derived predicate in both places, so the list and the peek cannot disagree about whether an expense can be settled.

**8B. Show how it was discharged**
- `expenseView.tsx` gains a "Settlement" block stating the route in domain language: *Queued for payroll reimbursement* (with the payslip/run reference once `reimbursed_payslip_id`/`reimbursed_run_id` are stamped), *Reimbursed by direct payment* (with date and the journal reference), *Settled by the company at capture* for company/card-funded spend, or *Awaiting reimbursement* for an approved employee-paid expense with no route chosen yet.
- The corresponding lifecycle timeline entry distinguishes payroll vs direct discharge instead of a bare "Reimbursed" stamp.

**8C. Close the insert-side grant gap**
- Migration revoking `INSERT (reimburse_via_payroll)` from `authenticated`, so the payroll queue flag can only be set by `expense_queue_payroll_reimbursement`, which enforces `_expense_reimbursement_guard`.
- Client hooks stop sending the column on create if they do.

**8D. Extend the architecture ratchet**
- Add an assertion to `expense-domain-ownership.test.ts` that no client file `.insert()`s any server-owned column (`status`, `base_amount`, `exchange_rate`, `tax_amount`, `expense_number`, `journal_entry_id`, lifecycle timestamps, `reimburse_via_payroll`), so the insert-side revocations are ratcheted the same way the update side is.

**8E. Visibility empty states (carried over from the Phase 7 note)**
- Phase 6 narrowed visibility to Finance plus own/reports. The list and peek empty states must read as a scope statement ("you can see your own and your team's expenses") rather than "no expenses exist", so a legitimately narrowed view is not mistaken for a bug.

## Verification for this phase
- `bunx vitest run src/test/architecture/expense-domain-ownership.test.ts` plus the reversal-register, governance, SoD and journal-monopoly guards stay green (the `je-description-no-uuid` 143-violation baseline is pre-existing and unrelated).
- `tsgo --noEmit -p tsconfig.app.json` clean.
- `has_column_privilege('authenticated','public.expenses','reimburse_via_payroll','INSERT')` is `false` after the migration.
- Drive the preview: an approved employee-paid expense shows the settlement action in both the list menu and the peek; after direct reimbursement the peek states the route and the timeline shows the discharge.

## Out of scope (unchanged earlier decision)
Expense reports and corporate-card transaction import.
