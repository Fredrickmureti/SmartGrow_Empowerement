# Smart Grow Empowerment — microfinance convergence plan (reworked 2026-09-02)

Single source of truth. One institution, employee-operated, ASA branch model.
Inherited from AccrualFlow, deliberately: **document engine, auth engine (PIN),
navigation/UI foundation**, plus Finance strictly as the posting target (chart of
accounts, journal entries, GL, fiscal periods, fixed assets). Everything else is
out of scope and gets unwired in one sweep — never investigated module by module.

Backend: Supabase project `xwxqunklduknceoryrha` — already connected, no second
project, no new connection.

## Verified state (files + live DB, 2026-09-02)

| Milestone | Status |
| --- | --- |
| C1 lending scaffold, `/lending/*`, layout, nav | Done |
| C2 roles, `mf_account_mappings`, mappings settings screen | Done |
| C3 clients + groups | Done |
| C4 loan products + immutable versioning | Done |
| C5 applications → assessment → decision | Done |
| C6 loan creation, schedule engine, disbursement | Done |
| C6b accounting hook `mf_post_event` (mapping-resolved, hard error on gap) | Done — posting proven live |
| C7 repayments, policy allocation, reversal, server-derived balances | Done |
| C7b arrears/DPD/PAR, collections, officer/branch RLS scope | Done |
| C8a write-off + closure | Done |
| C8b top-up / restructure (RPC + `reissueLoan` + lifecycle dialog + lineage) | Done |
| F1 journal path enum fix | Done |
| V1 live lifecycle proof | **PASS (2026-09-02)** |

## V1 — PASSED

Ran end to end against the live database: application (draft → submitted →
under_review → assessment → approved → ready_for_disbursement) → loan +
4-installment schedule → disburse → partial repay → repay → reverse → top-up →
successor disbursement → predecessor closure.

- every generated journal entry balances; zero unbalanced entries,
- reversal produced a contra entry, never an edit,
- predecessor `LN-000001` closed only on successor disbursement,
  successor `LN-000002` active with the carried outstanding principal,
- non-financial events (`loan_created`, `loan_topped_up`) correctly unposted.

Defects found and fixed to get there:
1. `_mf_application_guard` lacked the `ready_for_disbursement → disbursed`
   transition — this blocked every disbursement.
2. `mf_apps_status_chk` did not allow the `disbursed` value.
3. `mf_loans.application_id` was NOT NULL, blocking top-up/restructure
   successors; now nullable with
   `CHECK (application_id IS NOT NULL OR parent_loan_id IS NOT NULL)`.

Temporary proof helpers dropped. V1 proof rows remain (financial history is
deliberately non-deletable).

**Resume point: C9.**

## C9 — Reports & documents on the inherited engines

Register microfinance definitions into the existing report/document engines with
institution settings injected. No new renderer, no new PDF path, no new export
mechanism.

- Reports: loan portfolio, outstanding principal/interest, daily/officer/branch
  collections, arrears aging + PAR, client statement/exposure,
  applications/approvals/disbursements.
- Documents: loan agreement, repayment schedule, loan statement, payment
  receipt, disbursement confirmation, collection receipt.

## C10 — Hardening, then one bulk ERP removal sweep

1. RLS/grants audit across `mf_*` only; reversal, duplicate and approval
   controls; security scan.
2. Institution settings page (name, legal, address, contact, logo, currency,
   financial settings) confirmed as the single source feeding reports and docs.
3. **Single grouped removal** — already decided, no per-module analysis:
   - Apps/routes/nav: retail/POS, inventory, warehouse, procurement,
     sales/order-to-cash, CRM, payroll, attendance, HR beyond user + role +
     branch assignment. Contacts survives only if lending clients depend on it.
   - Finance registry: keep chart of accounts, journal entries, fiscal periods,
     fixed assets, reports, settings. Drop receivables, payables, customer
     credits/statements, budgets, bank feeds, reconciliation, consolidation.
   - Their hooks, components, tests and schema go in the same sweep.

## Working rules

1. Financial state is derived server-side. React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is an append-only business event with an accounting hook.
   Account mappings are configuration — never a hardcoded account UUID.
3. Every new public object ships GRANTs + RLS in the same migration; one object
   per migration.
4. History is never edited. Top-up, restructure, write-off, closure create rows.
5. Permanently out of scope: SaaS/tenants/subscriptions, payroll, attendance,
   POS, inventory, warehouse, procurement, order-to-cash, CRM, client portal,
   public registration, hardware.
6. Never fix, document or explore an out-of-scope ERP surface. If it is on the
   C10 delete list, a bug in it is not a bug.
7. Verification per milestone: typecheck + exercise the flow against the live
   database. Update this file immediately after each step.

## Next action

C9 step 1 — register the microfinance report definitions in the inherited
report engine (portfolio + arrears first), institution settings injected, no new
renderer. Then the document definitions. Then C10.
