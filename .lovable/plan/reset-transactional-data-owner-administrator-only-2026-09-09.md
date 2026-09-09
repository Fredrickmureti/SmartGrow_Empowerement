# Reset Transactional Data (owner/administrator only)

Goal: the owner can return the institution to a clean testing state — all lending and
financial activity gone, all setup (people, branches, access groups, products, chart of
accounts, settings) untouched — in one controlled, all-or-nothing operation.

## 1. What already exists (verified in the live database)

- A reset framework is already built and in use: `reset_categories(org_id, categories[])`
  dispatches to `reset_module__*` functions (finance, banking, transactions_ledger,
  ancillaries, sequences, sales, purchases, inventory, pos, warehouse, fixed_assets,
  vendor_returns) and returns per-category counts.
- Authorization already exists and is server-side: every reset calls
  `_assert_reset_permission(org_id)`, which allows only a platform admin or an active
  `owner`/`admin` role in that organization, and raises `42501` for everyone else.
  Loan officers, cashiers, accountants, auditors and ordinary members are rejected even
  if they call the function directly.
- Immutability/append-only guards across the database already honour the teardown
  context (`app.reset_in_progress`), which `reset_categories` sets, so journal, payslip
  and history guards do not abort a reset.
- **Gap:** there is no microfinance category. None of the 34 `mf_*` tables are cleared by
  any existing module. There is also no screen anywhere in the app that invokes a reset.

## 2. Reset boundary

Removed (transactional):

- Lending: `mf_loan_applications`, `mf_application_assessments`, `mf_loans`,
  `mf_loan_schedule`, `mf_loan_disbursements`, `mf_loan_charges`, `mf_client_charges`,
  `mf_loan_events`, `mf_repayments`, `mf_repayment_allocations`, `mf_repayment_batches`,
  `mf_collection_activities`, `mf_collection_bankings`, `mf_event_postings`,
  plus `loan_lifecycle_events` and `loan_skip_override_events` for the affected loans.
- Accounting produced by that activity, through the existing `finance`,
  `transactions_ledger` and `banking` modules: journal entries and lines, payments and
  allocations, bank transactions, reconciliation sessions/matches/write-offs, accounting
  events, fx revaluation runs.
- Document numbering counters reset via the existing `sequences` module, so the next test
  cycle starts numbering from one.

Preserved (master/configuration): auth users, `user_roles`, `member_permission_groups`,
`permission_groups` and their rules, branch assignments, organizations, businesses,
branches, `mf_loan_products` and `mf_loan_product_versions`, `mf_account_mappings`,
`mf_allocation_policy`, `mf_client_fee_policy`, chart of accounts, journal books, default
account settings, fiscal periods, currencies, bank *accounts* (the account record, not its
transactions), email/document templates, and all settings tables.

Clients and groups (`mf_clients`, `mf_groups`, `mf_group_members`): these sit on the
boundary — they are master data in the domain model but they are also the test data the
owner recreates each cycle. They are therefore **opt-in**: a separate checkbox on the
screen, off by default. When off, clients survive with zero loans; when on, they are
removed after all lending rows that reference them.

## 3. Deletion order

Children before parents, inside one transaction, all scoped by `business_id` for the
organization's businesses:

```text
event_postings -> repayment_allocations -> repayments -> repayment_batches
  -> collection_bankings -> collection_activities
  -> loan_charges / client_charges -> loan_schedule -> loan_disbursements
  -> loan_events / loan_lifecycle_events / loan_skip_override_events
  -> loans -> application_assessments -> loan_applications
  -> (optional) group_members -> groups -> clients
then existing modules: banking -> transactions_ledger -> finance -> ancillaries -> sequences
```

The derived reporting objects (`mf_loan_balances`, `mf_par_aging`, `mf_client_exposure`,
`mf_collections_by_branch`, …) are views, not tables — they empty themselves.

## 4. Server/database implementation

- New `reset_module__microfinance(org_id uuid) returns jsonb`, security definer, same
  shape and conventions as the sibling modules, returning a count per table.
- Register `'microfinance'` in `reset_categories`, and add a
  `reset_transactional_data(org_id uuid, confirmation text, include_clients boolean)`
  wrapper that: asserts permission, requires the confirmation phrase
  `RESET TRANSACTIONAL DATA`, runs microfinance + banking + transactions_ledger +
  finance + ancillaries + sequences in one call (one transaction — any error rolls the
  whole thing back), runs an integrity check (no lending rows left, no orphaned journal
  lines), writes an `admin_audit_log` row with actor, organization, counts and result,
  and returns the counts.
- New `preview_transactional_reset(org_id uuid)` returning per-category counts for the
  confirmation screen, read-only, same permission assertion.
- Audit rows are written *after* the deletes and are never removed by the reset.
- The frontend calls one server function; it never issues deletes.

## 5. UI

New "Reset transactional data" panel in the administrator area of Settings → Workspace,
rendered only for owner/admin (server still enforces it):

1. Red danger card with an explicit explanation of what is removed and what is kept.
2. Click → dialog showing live counts pulled from the preview function, the preserved
   list, and the optional "also remove clients and groups" checkbox.
3. Requires typing `RESET TRANSACTIONAL DATA` before the confirm button enables.
4. On success, shows the counts actually deleted.

## 6. Testing (to be run and reported, not assumed)

- Seed a full cycle (client → group → application → approval → loan → disbursement →
  repayments → allocations → journal entries → collection banking), run the reset,
  and verify: lending tables empty, users/roles/groups/permissions/branches/products/
  chart of accounts intact, no orphaned journal lines, no broken foreign keys.
- Call the function under a loan officer, cashier, accountant and plain member JWT —
  each must fail with `42501`; then as the owner — must succeed.
- Run the reset twice: the second run on an already-clean database must succeed with
  zero counts and change no configuration.
- Typecheck.

Final verdict (architecture / authorization / cleanup / integrity / protected data /
end-to-end) will be reported against these tests, with exact reasons for any failure.

## 7. Risks

- The reset is organization-wide across all businesses in the organization; there is one
  institution here, so that matches intent.
- Browser sign-in as the non-admin test users cannot be exercised (external Supabase, no
  preview session can be minted); authorization will be proven at the database layer with
  each user's own token, as in the previous access-control work.
