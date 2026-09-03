# Microfinance Convergence — Authoritative Plan

Reworked 2026-09-03. One institution, employee-operated microfinance platform
(ASA-style branch model) built on the existing codebase. Reuse proven engines;
carry no ERP domain logic forward. Two milestones remain.

## Locked decisions — do not re-litigate

REUSE as infrastructure (adapt wording/data, never rebuild): auth/PIN + invite
engine, document generation engine, navigation/app shell + UI system, Chart of
Accounts / journals / GL / fiscal periods, banking + bank reconciliation, the
payment settlement + allocation engine, fixed assets, company/general settings,
audit logging, reporting engine, storage/file handling.

ADAPTED to microfinance (done): receipts/settlement → loan repayment receipts and
disbursement confirmations; customer statement → client + loan statement;
receivables ageing → arrears / PAR; deposits → officer collection banking of
daily cash and mobile money.

OUT: sales, purchases, POS, inventory/products, warehouse, CRM, projects, HR,
payroll, recruitment, attendance, timesheets, marketplace/entitlements,
multi-tenancy, client portal.

## Verified state (re-checked 2026-09-03 against code + database)

- Supabase project `xwxqunklduknceoryrha` (Smart Grow Empowerment) is connected;
  no reconnection needed.
- `src/apps` = dashboard, finance, lending, platform, reports, studio only.
  `src/pages` holds only platform, auth, finance (accounts, journals, fiscal
  periods, fixed assets, banking, reconciliation), reports, settings, team.
  No ERP sales/purchase/inventory/HR/payroll surfaces remain.
- Database confirmed: 24 `mf_*` objects live — clients, groups + members, loan
  products + versions, applications, assessments, loans, schedule, disbursements,
  events, repayments, allocations, batches, collection activities, collection
  bankings, account mappings, allocation policy, event postings, plus derived
  views `mf_loan_balances`, `mf_loan_arrears`, `mf_loan_installment_status`,
  `mf_par_summary`, `mf_client_statement`. Financial authority is server-side.
- Lending frontend complete: clients, groups, products/versions, applications
  (form → assessment → decision), loans (create, disburse, schedule, lifecycle),
  repayments (individual and group-meeting batch, one allocation policy),
  collections, 5 reports, accounting mappings, documents via the shared engine.
- C12 RBAC gating, C13 accounting integration (`mf_post_event` →
  `mf_resolve_account` → `post_journal_entry_atomic`), C14 cash & settlement
  retarget, C15a ERP surface strip, C15c dashboard retarget: all DONE.

## M1 — Operating baseline + live lifecycle verification (NEXT)

The database is empty of operating data, so every KPI reads zero. This milestone
is both the baseline setup and the end-to-end verification C15b depends on.

1. Seed the institution baseline: accounting mappings (loan principal
   receivable, interest income, fee income, penalty income, cash, bank, mobile
   money, write-off expense), allocation policy, at least one loan product +
   version, one branch/officer assignment.
2. Run one real flow through the UI: client → group (optional) → application →
   assessment → approval → disbursement → repayment (individual and one group
   batch) → close batch → bank → reconcile.
3. Verify against that data: dashboard KPIs, arrears/PAR (confirm
   `mf_par_summary` returns amount vs percentage and match the KPI label), one
   report render, one client-statement and one repayment-receipt render.
4. Fix the shell hydration mismatch logged on load.

Exit: every step above observed working; discrepancies fixed, not documented.

## M2 — C15b final dead-code strip & hardening (LAST)

- Confirm by import graph, then remove: `useDashboardStats`,
  `useDashboardAnalytics` (ERP revenue/expense math, reachable only from
  `AIInsightsWidget` and `useDashboardComposition`) and the module/entitlement
  gating they carry.
- Prune `src/parked-modules.d.ts` stubs no retained file needs.
- Close-out: typecheck, build, permission/RLS pass.

## Rules

- No payroll, HR product, multi-tenancy, client portal, or ERP workflow revival.
- Never a second implementation where a mature engine exists — adapt it.
- No frontend-authoritative financial math; balances, interest, arrears and
  allocations come from the database.
- Individual and group repayment share one code path and one allocation policy;
  group membership never implies joint liability.
- Do not investigate, document, or polish anything outside microfinance scope.



======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================


Collection batches are now protected server-side — a closed batch can't be reopened and no receipt can be attached to one (verified by a live self-test)


==============================NOTE===============================

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot,  and  if its payment being receuived,  and on the payment reception we need to reason critically here because this sytem is almost operating almost like ASA international kenya which uses the typical old microfinance tradition because this is an upcoming microfiannce startapp  where we have something loan officer overseeign a group but still that does not mean tje system should not allow single customer payment so this means I need you to help me reason here, dont ask me question, just know you are dealign with a microfiannce system  and such not the old erp which dealth with the typical procurement and sales kind of flow no room for an error, be anaytical and critical executioner, like basically for fiannce what can be reusable let it be reused and now be tailpored to the microfiannce from  fixed assets, to generaal settings to fiscal periods and such (its up to you to analyze what and what nots that needs  to be retained because you are the engineer)

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
