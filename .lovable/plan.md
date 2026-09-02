# Smart Grow Empowerment — convergence plan (re-verified 2026-09-02, 07:2x UTC)

Single source of truth. Rewritten to remove drift. Read this, not the archive.

**Backend:** Supabase `xwxqunklduknceoryrha` — already connected. No connection
step exists or is needed.

**Reuse exactly three inherited things:** document generation engine, auth
engine (PIN), navigation/UI foundation. Finance is reused *only* as the posting
target: chart of accounts, journal, GL, fiscal periods, fixed assets. Every
other ERP domain is unwired now and deleted in one sweep at C10.

---

## Verified state (checked against `pg_proc`, `information_schema`, and files)

Confirmed present in the live database:

- Tables (18): `mf_clients`, `mf_groups`, `mf_group_members`, `mf_loan_products`,
  `mf_loan_product_versions`, `mf_loan_applications`, `mf_application_assessments`,
  `mf_loans`, `mf_loan_schedule`, `mf_loan_events`, `mf_loan_disbursements`,
  `mf_repayments`, `mf_repayment_batches`, `mf_repayment_allocations`,
  `mf_allocation_policy`, `mf_account_mappings`, `mf_event_postings`,
  `mf_collection_activities`.
- Views: `mf_loan_balances`, `mf_loan_installment_status`, `mf_loan_arrears`,
  `mf_par_summary`.
- Functions: `mf_resolve_account`, `mf_post_event`, `mf_generate_schedule`,
  `mf_create_loan_from_application`, `mf_disburse_loan`, `mf_record_repayment`,
  `mf_reverse_repayment`, `mf_write_off_loan`, `mf_close_loan`, plus scope
  helpers (`mf_loan_in_scope`, `mf_officer_in_scope`, `mf_is_portfolio_restricted`)
  and append-only triggers.
- UI: `/lending/*` shell with Clients, Groups, Products, Applications, Loans,
  Repayments, Collections, Configuration. Typecheck clean.

| Milestone | Status |
| --- | --- |
| C1 shell + `/lending/*` scaffold | DONE |
| C2 roles + `mf_account_mappings` + config screen | DONE |
| C3 clients + groups | DONE |
| C4 loan products (immutable versions) | DONE |
| C5 applications → assessment → decision | DONE |
| C6 loan + schedule + disbursement | DONE |
| C6b accounting hook (`mf_post_event`) | DONE |
| C7 repayments + allocation + reversal | DONE |
| C7b arrears, PAR, collections, portfolio RLS | DONE (code + schema; **live cycle not yet exercised**) |
| C8 write-off + closure | DONE |
| C8b top-up + restructuring | **PENDING — resume point** |
| C9 reports + documents | PENDING |
| C10 hardening + single ERP removal sweep | PENDING |

**Genuine resume point: V1 (one live lifecycle verification), then C8b.**

---

## V1 — Live lifecycle verification (do first, small)

Configure mappings, then run one loan end to end: create → disburse → repay →
reverse → close. Assert the journal balances and that `mf_loan_balances` agrees
with the GL. Fix whatever it exposes. No new features in this step.

## C8b — Top-up and restructuring

Settle-and-reissue business events on the same loan lineage:

- `mf_topup_loan` / `mf_restructure_loan`: approval-guarded, close the current
  schedule version, generate a new one, record a `loan_topped_up` /
  `loan_restructured` event, post through `mf_post_event`.
- History is never edited. Schedule rows get a version, not an UPDATE.
- UI: extend `LoanLifecycleDialog` with the two actions.

## C9 — Reports & documents on the existing engines

Register into the inherited engines; write no new renderers.

- Reports: portfolio / outstanding principal + interest, daily / officer /
  branch collections, arrears aging + PAR, client statement and exposure,
  applications–approvals–disbursements.
- Documents: loan agreement, repayment schedule, loan statement, payment
  receipt, disbursement confirmation, collection receipt.
- Institution data comes from company settings, never hardcoded.

## C10 — Hardening + one bulk ERP sweep

1. RLS/grants audit on every `mf_*` object; reversal, duplicate and approval
   controls; security scan.
2. Then one grouped removal:
   - Finance registry: drop receivables, payables, customer credits, customer
     statements, budgets, bank feeds, reconciliation. Keep chart of accounts,
     journal entries, fiscal periods, fixed assets, banking, reports, settings.
   - Drop the Contacts app (clients live in `mf_clients`).
   - Employees collapses to user list + role + branch assignment only.
   - Drop dead schema and tests: retail/WMS, payroll, attendance, procurement,
     POS, CRM, sales, inventory.

---

## Working rules

1. Financial state is derived server-side. React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is a business event with an accounting hook. Account
   mappings are configuration; a missing mapping is a hard error, never a
   fallback account.
3. One object per migration, with GRANTs + RLS in the same migration.
4. Inherited ERP rows are not this institution's data.
5. Permanently out of scope: SaaS/tenants/subscriptions, payroll, attendance,
   POS, inventory, warehouse, procurement, order-to-cash, client portal, public
   registration, hardware.
6. Verification per step: typecheck + exercise the affected flow live. Full
   suite green is a C10 goal; inherited ERP test failures die in C10.
7. No exploratory audits of code or tables already known to be out of scope.
   The linter's ~3,670 findings are inherited surface scheduled for C10.
8. Update this file after every completed step. Never trust a prior claim
   without checking the file or object it names.

## Next action

V1 live lifecycle verification, then C8b.
