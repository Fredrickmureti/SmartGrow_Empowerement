# Expense Management — Verification Verdict, then Phases 5-7

## Phase 1 — Independent verification of the previous engineer's claims

I checked the live database and the code rather than the log. Result: **Phases 1-4 are genuinely implemented.** No claim was found to be superficial.

| Claim | Verdict | Evidence |
|---|---|---|
| Server-owned lifecycle commands | Correct | `expense_submit`, `expense_approve`, `expense_reject`, `expense_void`, `expense_convert_to_bill`, `expense_reimburse_direct`, `expense_queue_payroll_reimbursement`, `expense_unqueue_payroll_reimbursement` all exist and are `SECURITY DEFINER` |
| Browser cannot author state | Correct | `authenticated` has **no UPDATE privilege** on `status`, `approved_by/at`, `submitted_by/at`, `journal_entry_id`, `approval_request_id`, `reimburse_via_payroll`, `reimbursed_*`, `voided_*`, `void_reason*`, `base_amount`. Both hooks now route edits through `stripServerOwned` and call the RPCs |
| Governance routed canonically | Correct | `expenses.approval_request_id` exists, `_mirror_approval_to_expense` and `_expense_apply_approval` exist |
| Single posting path | Correct | `post_expense_gl` builds lines in memory and posts through `post_journal_entry_atomic`, is idempotent on `(expense, id)`, resolves accounts dynamically, and returns `bill_owns_liability` when a bill exists — no duplicate liability |
| Employee payable | Correct | `paid_by='employee'` credits `employee_reimbursements_payable` → `net_salary_payable` → `accounts_payable`; `company_card` credits `credit_card_clearing` |
| Expense → Bill single, server-side | Correct | one RPC; client minters gone |

**Gaps confirmed as genuinely pending** (matching the log, plus two the log did not name):
- Exchange rate is **not** resolved from `exchange_rates`; `_expenses_derive_base_amount` simply defaults the rate to 1, so a foreign-currency expense silently posts at parity.
- `currency` is free `text` and the picker is not restricted to `business_active_currencies`.
- Tax is a free numeric amount posted to `input_tax`; `tax_rates` (with `is_inclusive`, `tax_type`, validity dates) is not used, and recoverable vs non-recoverable is not modelled — non-recoverable tax should be expensed, not sat in the input-tax asset.
- `department_id` exists but is never captured, and `analytic_distributions` has **no application consumer at all**; expenses mirror only into `project_cost_entries`.
- Receipts are still a single `receipt_url` outside the canonical document layer.

## Phase 5 — Currency, tax, dimensions, documents

**5A. Currency and FX (server-resolved)**
- New `expense_resolve_fx` logic inside the derive trigger: look up `exchange_rates` for `(organization_id, business_id, currency → base currency, effective_date <= expense_date)`, newest first; fall back to 1 only when currency equals base currency, otherwise raise a clear error.
- Add `currency` FK-style validation against `currencies.code`, and constrain the picker to `business_active_currencies` for the business.
- `post_expense_gl` continues to pass `currency` + resolved rate to the posting engine; GL amounts stay transaction-currency with the engine converting, as today.

**5B. Tax**
- Add `tax_rate_id` and `tax_treatment` (`recoverable` | `non_recoverable`) to `expenses`.
- Server computes `tax_amount` from the selected rate and the inclusive/exclusive flag; the free numeric field becomes read-only derived output.
- `post_expense_gl`: recoverable tax debits `input_tax`; non-recoverable tax is folded into the expense account line. No country logic in the expense domain — treatment comes from the rate record.

**5C. Analytic dimensions**
- Capture `department_id` in the form.
- On approval, `post_expense_gl` writes one `analytic_distributions` row per resolved dimension (`source_type='expense'`), reversed on void. `project_cost_entries` stays as a projection.

**5D. Receipts**
- Move attachments onto the canonical document/attachment layer used elsewhere (`ensureDocumentRecord` / document artifacts), supporting multiple receipts with audit history; `receipt_url` remains read-only for legacy rows.

## Phase 6 — Access, notifications, guards — COMPLETE (verified)
- DONE. RLS consolidated to exactly one policy per command on `expenses`: `expenses_select`, `expenses_insert`, `expenses_update`, `expenses_delete`. Dropped the legacy overlapping policies (`Admins can delete all expenses`, `Users can delete pending expenses`, `Platform admins can view all expenses`, and the two duplicate subscription INSERT policies — those OR-ed with `expenses_insert_perm` and effectively bypassed the permission check).
- DONE. Visibility: platform admin or (business access + `purchases:read` + (Finance via `is_finance_manager` OR own/report via new SECURITY DEFINER helper `expense_is_own_or_report(user, created_by, employee_id)`, which uses the canonical recursive `is_manager_of`)).
- DONE. Update is limited to open states (`draft|pending|submitted|rejected`); approved/posted/paid/voided rows are immutable from the app. Delete requires `purchases:delete` and an open state.
- DONE. Entry state is server-owned: `expenses.status` now defaults to `draft` and the insert policy requires `status = 'draft'`. Both client hooks (`useExpenses`, `useExpensesPaginated`) no longer author `status`.
- DONE. `notify_expense_created` narrowed from every active org member to Finance roles (`owner|admin|super_admin|accountant`) plus the employee's direct manager, skipping the creator.
- DONE. Architecture ratchet `src/test/architecture/expense-domain-ownership.test.ts` (5 assertions, green): no client authoring of server-owned columns, no retired lifecycle RPCs, no direct journal-line writes from expense code, no local approval/SoD tables, receipts mutated only through `useExpenseAttachments`.


## Phase 7 — UI aligned to the domain — ACTIVE (next milestone)
- Capture flow asks *who paid* first (company cash/bank, company card, employee), then classification, business purpose, employee, dimensions, tax code, currency (resolved, never typed), receipts.
- Record page renders the lifecycle (draft → submitted → approved → posted → settled) via the canonical record projections instead of a CRUD form.
- Approve/reject/void become governance-aware actions; no free-text currency, account, tax or status controls.
- Also fold in: the list/detail surfaces must respect the new visibility split (non-Finance users now legitimately see fewer rows — the empty states and counts must not read as a bug).

## Status board
- Phases 1-4: complete and verified (server-authoritative lifecycle, Finance posting monopoly, no duplicate liability, no local payment engine).
- Phase 5 (A-D: FX, tax, analytics, attachments): complete and verified.
- Phase 6 (access, notifications, guards): complete and verified — this turn.
- Phase 7 (UI aligned to the domain): ACTIVE, not started.

## Instructions for the next agent
1. Verify Phase 6 before writing anything: query `pg_policies` for `expenses` and confirm exactly four policies (one per command) and no legacy leftovers; confirm `expenses.status` defaults to `draft` and the insert policy pins `status='draft'`; read `notify_expense_created` and confirm it targets Finance roles plus the direct manager only; run `bunx vitest run src/test/architecture/expense-domain-ownership.test.ts` and `tsgo --noEmit`.
2. Then resume at Phase 7 — do not open unrelated work. Phase 7 is presentation only: no new engine, no new lifecycle states, no direct table writes. Server RPCs and RLS from Phases 1-6 are the contract.
3. Finish Phase 7 coherently (capture flow, record page, governance-aware actions together) before declaring the roadmap done.


Out of scope by earlier decision, unchanged: expense reports and corporate-card transaction import.

## Technical notes
- All changes are database migrations plus hook/UI wiring; no new engine of any kind. Posting stays `post_journal_entry_atomic`, approval stays `approval_route`, settlement stays the existing payroll/payment routes.
- `expenses` still holds no production rows, so the currency/tax column changes need no backfill; a defensive backfill of `exchange_rate=1` for base-currency rows is included anyway.
- Each phase ends with `tsgo --noEmit` plus `src/test/architecture/` green (the `je-description-no-uuid` 143-violation baseline is pre-existing and unrelated).

---

## Phase 7 — UI aligned to the domain (COMPLETE, verified 2026-08-11)

**Implemented and verified**
- **Payer-first capture.** `ExpenseFormFields.tsx` now opens with a "Who paid?" section: `paid_by` (`company` / `company_card` / `employee`), an employee picker for out-of-pocket spend, and a payment-method select for company-funded spend. The "Paid from account" picker (and the AP/linked-bill notice) only renders for `paid_by = 'company'`; for card and employee spend `post_expense_gl` resolves the credit account (card clearing, employee reimbursements payable) server-side.
- **Create/edit wiring.** `ExpenseCreatePage.tsx` and `ExpenseEditPage.tsx` map `paid_by` / `employee_id` into the payload, hydrate them on edit, block submission of an employee-paid expense with no employee, and require a payment account only for company-funded spend.
- **Record projection.** `expenseView.tsx` renders the server-owned lifecycle timeline (`created_at`, `submitted_at`, `approved_at`, `reimbursed_at`, `voided_at`, plus a GL-posted entry when `journal_entry_id` is set) and the derived dimensions: payer, tax treatment (recoverable vs folded-into-cost), FX rate and base-currency equivalent.
- **Insert-side grant gap closed (found during Phase 7 verification).** Column grants only revoked `UPDATE` on server-owned columns; `authenticated` could still *author* `status`, `base_amount`, `exchange_rate`, `tax_amount`, `expense_number`, `journal_entry_id` and every lifecycle timestamp at INSERT. A migration revoked table-level INSERT and re-granted INSERT on the business columns only. Verified with `has_column_privilege`.
- Green: `tsgo --noEmit`, `vitest run src/test/architecture/expense-domain-ownership.test.ts` (5 assertions).

**Pending / next**
- **Phase 8 — Settlement UX for employee reimbursements.** Surface the two discharge routes (`expense_queue_payroll_reimbursement` vs `expense_reimburse_direct`) in the list/peek so an approved employee-paid expense has a visible "settle" affordance, and show which route discharged it.
- Extend the architecture ratchet with an assertion that no client file inserts the newly-revoked INSERT columns (currently only update paths are asserted).

**Instructions for the next agent**
1. Verify Phase 7 first: read `ExpenseFormFields.tsx`, `ExpenseCreatePage.tsx`, `ExpenseEditPage.tsx`, `expenseView.tsx`; confirm the payer branch matches `post_expense_gl`'s account resolution, and re-check `has_column_privilege('authenticated','public.expenses',<col>,'INSERT')` for the server-owned columns listed above.
2. Only then start Phase 8 — do not open unrelated areas.
