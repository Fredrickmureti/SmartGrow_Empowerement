# Smart Grow Empowerment — microfinance convergence plan (reworked 2026-09-02)

Single source of truth. One institution, employee-operated. Reuse exactly three
inherited things: the document engine, the auth engine (PIN), and the
navigation/UI foundation. Finance is reused only as the posting target (chart of
accounts, journal, GL, fiscal periods, fixed assets). Every other ERP surface is
unwired and dropped in one sweep, not explored.

Backend: Supabase project `xwxqunklduknceoryrha` (already connected).

## Verified state (checked against files and generated DB types, 2026-09-02)

| Milestone | Status |
| --- | --- |
| C1 lending scaffold, `/lending/*` routes, layout, nav | Done |
| C2 roles, `mf_account_mappings`, mappings settings screen | Done |
| C3 clients + groups (tables, hooks, pages) | Done |
| C4 loan products + versioning | Done |
| C5 applications → assessment → decision | Done |
| C6 loan creation, schedule engine, disbursement | Done |
| C6b accounting hook (`mf_post_event`, mapping-resolved, hard error on missing mapping) | Done |
| C7 repayments, policy-driven allocation, reversal, server-derived balances | Done |
| C7b arrears/DPD/PAR views, collections activities, officer/branch RLS scope | Done (collections page + `useMfCollections` present) |
| C8a write-off + closure (`mf_write_off_loan`, `mf_close_loan`, wired in UI) | Done |
| C8b top-up / restructuring | **Backend only** — `mf_reissue_loan`, loan lineage columns, successor settlement posting exist; **no UI, no hook** |

Nothing in the frontend calls `mf_reissue_loan`; `useMfLoans` wires create,
disburse, write-off, close only.

**Resume point: C8b frontend.**

## C8b — Top-up / restructure UI (next)

1. `useMfLoans`: add a `reissueLoan` mutation calling `mf_reissue_loan`
   (loan, kind, additional amount, term, rate, dates, reason), invalidating
   loans + schedule + balances.
2. `LoanLifecycleDialog`: add Top up and Restructure actions — reason required,
   additional principal input disabled for restructure, product-flag gated
   (`allow_topup` / `allow_restructure`).
3. `LoansPage`: show lineage on the row (replaces / replaced by), successor loan
   linked.
4. Verify: reissue one active loan → successor in `pending_disbursement`,
   schedule generated, predecessor closed only on successor disbursement, journal
   balanced.

## V1 — One live lifecycle proof

Single loan through disburse → repay → reverse → top-up → close. Confirm journal
entries balance and GL agrees with `mf_loan_balances`. This gates C9.

## C9 — Reports & documents on the inherited engines

Register microfinance definitions into the existing report and document engines
with institution settings injected. No new renderers, no new PDF path.

- Reports: loan portfolio, outstanding principal/interest, daily/officer/branch
  collections, arrears aging + PAR, client statement/exposure,
  applications/approvals/disbursements.
- Documents: loan agreement, repayment schedule, loan statement, payment
  receipt, disbursement confirmation, collection receipt.

## C10 — Hardening, then one bulk ERP removal sweep

1. RLS/grants audit across `mf_*`; reversal, duplicate and approval controls;
   security scan.
2. Single grouped removal — no per-module investigation, these are already
   decided out of scope:
   - Apps/routes/nav: contacts, retail/POS, inventory, warehouse, procurement,
     sales/order-to-cash, CRM, payroll, attendance, HR beyond user + role +
     branch assignment.
   - Finance registry: keep chart of accounts, journal entries, fiscal periods,
     fixed assets, banking, reports, settings. Drop receivables, payables,
     customer credits, customer statements, budgets, bank feeds, reconciliation.
   - Their hooks, components, tests and dead schema go with them.
3. Institution settings page (name, legal, address, contact, logo, currency,
   financial settings) confirmed as the single source feeding reports and
   documents.

## Working rules

1. Financial state is derived server-side. React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is an append-only business event with an accounting hook.
   Account mappings are configuration — never a hardcoded account UUID.
3. Every new public object ships GRANTs + RLS in the same migration; one object
   per migration.
4. History is never edited. Top-up, restructure, write-off and closure create
   new rows/events.
5. Permanently out of scope: SaaS/tenants/subscriptions, payroll, attendance,
   POS, inventory, warehouse, procurement, order-to-cash, CRM, client portal,
   public registration, hardware.
6. No exploratory audits of code or tables already known to be out of scope.
   Removal happens once, in C10, as a sweep.
7. Verification per milestone: typecheck + exercise the affected flow against the
   live database. Update this file immediately after each step.

## Next action

C8b step 1 — `reissueLoan` in `useMfLoans`, then the Top up / Restructure
actions in `LoanLifecycleDialog`, then lineage on `LoansPage`.



=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======


I paused the lifecycle verification here. Progress so far:

Fixed (applied to the database):
- The institution's owner account was locked out of every lending action — the loan create, disburse, repay-reversal, restructure, write-off and close functions, plus the application-decision guard, only accepted accounts explicitly labelled Super Administrator. They now accept the owner too. (The owner role itself is immutable, so widening the guards was the correct fix.)
- No new security-linter issues were introduced (count unchanged at the inherited baseline).

Remaining — V1 lifecycle proof (not finished):
The rollback-only test harness ran up to the assessment step and stopped on a value constraint: `mf_application_assessments.recommendation` doesn't accept `approve` (the allowed list still needs to be read from `mf_assess_recommendation_chk`). Once that value is corrected, the harness continues through: approval → loan creation + schedule → disbursement → two repayments → one reversal → top-up reissue and successor disbursement → journal debit/credit balance check against `mf_loan_balances`.

Also noted for later (C10 hardening, not fixed): the `mf_loan_products` insert policy rejects the owner under real RLS, so product creation from the UI will likely fail for that account even though the function guards now pass — the RLS policies need the same owner allowance as the guards.

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
