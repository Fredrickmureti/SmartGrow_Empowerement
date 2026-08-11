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

## Phase 6 — Access, notifications, guards
- Split RLS: employee sees own (`employee_id`/`created_by`), manager sees their reports, Finance/`purchases:write` sees all; drop the legacy overlapping policies so exactly one policy per command remains.
- Narrow `notify_expense_created` from "every org member" to approvers/Finance.
- Architecture tests: no client status writes to `expenses`, approval routed through the governance engine, expense present in the reversal register, single posting path.

## Phase 7 — UI aligned to the domain
- Capture flow asks *who paid* first (company cash/bank, company card, employee), then classification, business purpose, employee, dimensions, tax code, currency (resolved, never typed), receipts.
- Record page renders the lifecycle (draft → submitted → approved → posted → settled) via the canonical record projections instead of a CRUD form.
- Approve/reject/void become governance-aware actions; no free-text currency, account, tax or status controls.

Out of scope by earlier decision, unchanged: expense reports and corporate-card transaction import.

## Technical notes
- All changes are database migrations plus hook/UI wiring; no new engine of any kind. Posting stays `post_journal_entry_atomic`, approval stays `approval_route`, settlement stays the existing payroll/payment routes.
- `expenses` still holds no production rows, so the currency/tax column changes need no backfill; a defensive backfill of `exchange_rate=1` for base-currency rows is included anyway.
- Each phase ends with `tsgo --noEmit` plus `src/test/architecture/` green (the `je-description-no-uuid` 143-violation baseline is pre-existing and unrelated).
