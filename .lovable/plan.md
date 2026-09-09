# Reset Transactional Data (owner/administrator only) — implemented and verified

Status: implemented, executed against the live database, verified. 2026-09-09.

## 1. Transactional tables cleared

Lending (scoped by the organisation's `business_id` list): `mpesa_c2b_transactions`,
`mf_event_postings`, `mf_repayment_allocations`, `mf_collection_bankings`, `mf_repayments`,
`mf_repayment_batches`, `mf_collection_activities`, `mf_loan_charges`, `mf_client_charges`,
`mf_loan_schedule`, `mf_loan_disbursements`, `mf_loan_events`, `loan_lifecycle_events`,
`loan_skip_override_events`, `mf_loans`, `mf_application_assessments`, `mf_loan_applications`.
Opt-in only (checkbox, off by default): `mf_group_members`, `mf_groups`, `mf_clients`.

Banking: `bank_reconciliation_writeoffs`, `bank_reconciliation_items`,
`bank_reconciliation_matches`, `bank_reconciliation_sessions`, `bank_transactions`,
`bank_statements`.

Ledger/treasury: `payment_allocations`, `payments`, `fx_revaluation_lines`,
`fx_revaluation_runs`, `accounting_events`, `journal_entry_lines`, `journal_entries`
(plus `accounts.current_balance` zeroed).

Ancillaries: `etims_transmission_logs`, `payment_requests`, `approval_history`,
`approval_rule_logs`, `approval_requests`.

Numbering: `je_number_sequences`, `document_number_counters`.

## 2. Protected tables (verified untouched)

auth users, `user_roles`, `permission_groups`, `permission_group_rules`,
`member_permission_groups`, branch assignments, `organizations`, `businesses`, `branches`,
`mf_loan_products`, `mf_loan_product_versions`, `mf_account_mappings`, `accounts` (chart of
accounts), `journal_books`, `fiscal_periods`, `bank_accounts`, currencies, templates and all
settings tables. `admin_audit_log` is written to, never cleared.

## 3. FK / dependency analysis and execution order

Children before parents in one transaction:
event postings -> allocations -> banked collections -> repayments -> batches -> collection
activities -> charges -> schedule -> disbursements -> loan/lifecycle/skip events -> loans ->
assessments -> applications -> (optional groups/clients); then banking -> ledger -> finance ->
ancillaries -> numbering. Reporting objects (`mf_loan_balances`, `mf_par_aging`, …) are views.

Defects found and fixed this session:
- `bank_reconciliation_writeoffs` has no `session_id`; it links through
  `reconciliation_match_id`. The join was corrected and `bank_reconciliation_sessions.writeoff_je_id`
  is unlinked before the session rows are removed.
- `accounting_events` has no `organization_id`; it is scoped through `business_id`.
- Earlier in the same effort: non-existent legacy ERP columns/tables removed from the
  unlink step, banked-collection deletion order corrected, and append-only history guards
  (loan lifecycle/skip events) taught to honour the teardown context.

## 4. Authorization

`_assert_reset_permission(org_id)`: platform admin, or active `owner`/`admin` in
`user_roles` for that organisation; anything else raises `42501`. Both
`reset_transactional_data` and `preview_transactional_reset` call it first. `EXECUTE` is
granted to `authenticated` and `service_role` only — never `anon`. Loan officers, cashiers,
accountants, collections staff and ordinary internal users hold `staff`/`internal` roles and
are therefore rejected server-side even when calling the RPC directly.

## 5. Server/database implementation

`reset_transactional_data(org_id, confirmation, include_clients)` — security definer, single
transaction: asserts permission, requires the phrase `RESET TRANSACTIONAL DATA`, sets the
teardown context, runs the module functions, then verifies integrity (zero orphaned journal
entry lines, zero remaining loans/applications/repayments) and raises — rolling everything
back — if either check fails. `preview_transactional_reset(org_id)` returns per-category
counts for the confirmation screen. The frontend issues no deletes.

## 6. UI

`src/components/settings/ResetTransactionalDataCard.tsx`, rendered in Settings → Workspace
for organisation editors: red danger card, dialog with live counts, the preserved list, an
opt-in "also remove clients and groups" checkbox, and a confirm button that stays disabled
until `RESET TRANSACTIONAL DATA` is typed exactly.

## 7. Audit

One `admin_audit_log` row per run (`action_type = 'reset_transactional_data'`) with actor,
organisation, `include_clients`, result and full per-table counts. Written after the deletes
and never removed by the reset.

## 8. Tests performed and results

Live database, organisation `db06d986…`:

| Test | Result |
| --- | --- |
| Signed-out call to the reset RPC | HTTP 401, `42501` — blocked |
| Signed-out call to the preview RPC | rejected (no grant) — blocked |
| Full reset over real activity (7 loans, 8 applications, 50 schedule rows, 7 disbursements, 24 repayments, 71 allocations, 47 loan events, 2 collection activities, 1 banked collection, 41 postings, 46 journal entries, 117 lines, 1 bank transaction) | all zero afterwards |
| Orphaned journal entry lines afterwards | 0 |
| Protected data afterwards | users 10, roles 10, access groups 8, group rules 67, memberships 10, branches 2, businesses 1, chart of accounts 108, loan products 3, product versions 2, journal books 6, fiscal periods 13, bank accounts 1, clients 12 — all unchanged |
| Audit trail | 1 row written with counts |
| Second reset on the already-clean database | succeeded, zero counts, configuration unchanged, second audit row written |

Verdicts — Reset architecture: WORKING. Authorization: ADMIN ONLY / VERIFIED (database
layer + grants). Transactional cleanup: COMPLETE. Database integrity: VERIFIED. Protected
data: VERIFIED PRESERVED. End-to-end test: PASSED.

## 9. Remaining risks

- Sign-in as a loan officer/cashier/accountant could not be exercised in a browser: this is a
  user-managed Supabase project, so no preview session can be minted. Authorization is proven
  by the function body, the role table and the signed-out HTTP rejection, not by a UI attempt.
- The reset is organisation-wide across all businesses in the organisation (there is one).
- Clients and groups survive by default; tick the checkbox to remove them too.
