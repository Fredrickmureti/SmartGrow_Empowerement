# Expense Management — Architecture Audit & Convergence Plan

## A. What an Expense is in this ERP

An **Expense** is the capture of business expenditure that did **not** arrive as a
supplier invoice. Its defining question is *who fronted the money*:

```
Who paid?            → Settlement obligation
────────────────────────────────────────────────
Company cash/bank    → nothing owed (cash out at capture)
Company card         → card/clearing liability → card reconciliation
Employee personally  → employee payable → reimbursement (payroll or bank)
Supplier on credit    → NOT an expense: that is a Bill (AP owns it)
```

An Expense becomes an accounting event on **approval**, and a *settlement*
obligation only when the payer is not the company's own cash.

## B. Audit findings (evidence-based)

Verified against the live database and `src/`.

| # | Subsystem | Verdict | Evidence |
|---|---|---|---|
| 1 | GL posting | Correct | `post_expense_gl` builds lines in memory and posts via `post_journal_entry_atomic`; idempotent on `(source_type='expense', source_id)`; account resolution is dynamic (`resolve_expense_default_account`). No raw journal inserts. |
| 2 | Approval / governance | Architecturally wrong | `governance_action_registry` has `expense.approve` + `expense.approve_self_benefit`, but `expenses` has **no `approval_request_id`** and nothing calls `approval_route`. Approval is a raw client `UPDATE expenses SET status='approved'` (`useExpenses.ts:195`, `useExpensesPaginated.ts:369`). The `approve_expense` RPC exists but the UI never calls it. |
| 3 | SoD guard | Broken | `guard_expense_self_approval` only fires when `NEW.approved_by IS NOT NULL`. The UI writes `approved_by: null` (`Expenses.tsx:479`, `:307`) → self-approval guard is bypassed entirely. |
| 4 | Submission / lifecycle | Broken | `expense_status` enum = `pending, approved, rejected, paid` — no `draft`/`submitted`/`voided`, yet `submitted_by`/`submitted_at` columns exist, `approve_expense` tests dead `'draft','submitted'` branches, and the UI filters on a non-existent `'voided'` status (`Expenses.tsx:656`). Creation hardcodes `status:'approved'` — there is no submit step at all. |
| 5 | Employee reimbursement | Missing | `employee_id`, `reimburse_via_payroll`, `reimbursed_payslip_id/run_id` exist on the table but **no code reads or writes them** (verified: no DB function and no `src/` reference outside the original migration). `payment_method='employee_reimbursement'` credits generic **Accounts Payable**, not an employee payable — an employee creditor is indistinguishable from a supplier creditor and can never be settled or aged. |
| 6 | Expense → Bill bridge | Broken | Bill is minted **client-side** (`useExpensesPaginated.ts:172-295`, duplicated again in `pages/finance/AccountsPayable.tsx:208`) with an explicit retry that re-inserts on any failure, and `idx_bills_source_expense` is **non-unique** → duplicate bills / duplicate liability are possible. The expense JE already credits AP for `payment_method='payable'`, so expense posting + bill posting can double-count the same economic event. |
| 7 | Reversal | Needs improvement | Void calls `void_journal_entry_atomic` from the browser and leaves `expenses.status` untouched; `expense` is absent from `REVERSIBLE_DOCUMENTS` (`src/services/reversal/registerModules.ts`) so it is invisible to the reversal register. |
| 8 | Currency | Needs improvement | `expenses.currency` is free `text` defaulting to `'USD'`; no rate, no base-currency amount, no FX. UI defaults to `baseCurrency` but any string can be stored, and a foreign-currency expense has no convertible value. |
| 9 | Receipts | Needs improvement | Single `receipt_url text`; the canonical document/attachment infrastructure is unused, and the UI never populates it. |
| 10 | Tax | Needs improvement | `tax_amount` is a free number split to an `input_tax` account; no tax-code selection, no recoverable/non-recoverable distinction, no localization link. |
| 11 | Analytic dimensions | Needs improvement | `department` absent; `project_id`/`task_id` feed `project_cost_entries` via `trg_expense_to_cost`, bypassing the canonical `analytic_distributions` architecture. |
| 12 | Expense reports | Absent | No report/grouping table. Correct to leave absent for now — but then "expense report approval" is out of scope, not silently faked in UI. |
| 13 | Company card | Absent by design | `credit_card` maps to a clearing account only; no card-transaction import. Reconciliation stays downstream (`bank_transactions` / reconciliation engine) — boundary is intact. |
| 14 | Tenant / access | Needs improvement | RLS scopes by org + business + `purchases` module permission, plus legacy overlapping policies. There is **no employee self-ownership or manager-visibility model**: anyone with `purchases:read` sees every expense, and anyone with `purchases:write` can approve any expense. |
| 15 | Notifications | Needs improvement | `notify_expense_created` notifies **every org member** on every expense; approval/rejection uses the existing dispatcher (correct). |

## C. Convergence plan (in dependency order)

**Phase 1 — Lifecycle & server authority (migration + hook rewrite)**
- Extend `expense_status` with `draft`, `submitted`, `voided`; keep `pending` as a
  legacy alias mapped to `submitted`.
- Add domain commands: `expense_submit`, `expense_approve`, `expense_reject`,
  `expense_void` — each `SECURITY DEFINER`, each doing the transition **and** the
  posting/reversal in one transaction. Approval calls `post_expense_gl` internally.
- Revoke `UPDATE (status, approved_by, approved_at, journal_entry_id,
  submitted_by, journal…)` from `authenticated` so the browser cannot set state;
  clients call the RPCs only. `useExpenses`/`useExpensesPaginated` lose all raw
  status writes.
- Fix `guard_expense_self_approval` to derive the approver from `auth.uid()`
  instead of trusting `approved_by`.

**Phase 2 — Canonical governance**
- Add `expenses.approval_request_id`; `expense_submit` calls
  `approval_route('expense.approve', 'expense', id, amount)`. `NULL` return =
  policy does not gate → approve immediately (solo mode behaves as today).
- Add `_mirror_approval_to_expense()` AFTER UPDATE trigger on
  `approval_requests` (mirrors approved/rejected/cancelled back onto the expense,
  approval posting the GL).
- `expense_approve` refuses with `42501` / `HINT='GOV_USE_APPROVAL_ENGINE'` while a
  live request exists. All client calls go through
  `src/lib/governance/approvalEngine.ts`. No new engine, no new tables.

**Phase 3 — Employee payable & reimbursement**
- Resolve payer explicitly: `paid_by` = `company` | `employee` | `company_card`.
  Employee-paid expenses credit a dedicated **employee payable** account role
  (`employee_reimbursements_payable`), never generic AP.
- Reimbursement settles through existing infrastructure only:
  payroll (populate `reimburse_via_payroll` → payslip input, stamping
  `reimbursed_payslip_id/run_id`) **or** the existing payment/settlement engine
  for direct bank payment — with a caller-derived `client_request_id`
  (per `mem/features/money-in-idempotency.md`), never `crypto.randomUUID()`.
- Partial unique index guaranteeing one reimbursement per expense.

**Phase 4 — Expense → Bill bridge, server-side and single**
- One RPC `expense_convert_to_bill(p_expense_id, p_request_key)`; delete both
  client-side bill minters and the retry loop.
- `CREATE UNIQUE INDEX … ON bills(source_expense_id) WHERE source_expense_id IS NOT NULL`.
- Mutual exclusion: an expense that produces a Bill does **not** post its own AP
  credit — the Bill owns the liability. Enforced in `post_expense_gl`.
- Register `expense` in `REVERSIBLE_DOCUMENTS` + the `reversal_register` view.

**Phase 5 — Currency, tax, dimensions, documents**
- `currency` → FK to canonical currency entity, `exchange_rate` +
  `base_amount` resolved server-side from `exchange_rates`; no free text.
- Tax via tax-code selection with recoverable / non-recoverable treatment
  resolved by Finance/localization — no country logic in the Expense domain.
- `department_id` + write through `analytic_distributions`; keep the project cost
  mirror as a projection, not the source of truth.
- Receipts move to the canonical document/attachment layer; `receipt_url`
  retained read-only for legacy rows.

**Phase 6 — Access, notifications, guards**
- RLS: employee sees own, manager sees reports, Finance sees all; drop the legacy
  overlapping policies. Consolidate to one policy set per command.
- Narrow `notify_expense_created` to approvers/Finance instead of every member.
- Architecture tests: no client status writes to `expenses`; expense present in
  the reversal register; expense approval routed through governance.

**Phase 7 — UI aligned to the domain**
- Capture form asks *who paid* first, then classification, business purpose,
  employee, dimensions, tax code, currency (resolved, not typed), receipt upload.
- Submit → approval → posted → settlement rendered as a lifecycle, using the
  canonical `RecordShell` / document-record projections rather than a CRUD form.
- Approve/reject/void become governance-aware actions; no free-text currency,
  account, tax or status controls.

## D. Scope note

Phases 1-2 are the safety-critical core (self-approval bypass, client-authored
state) and Phase 4 closes the duplicate-liability hole. Phases 5-7 are
correctness and domain-fidelity work. Expense reports and corporate-card import
remain deliberately out of scope. `expenses` currently holds **0 rows**, so the
lifecycle and currency migrations carry no data-backfill risk.
