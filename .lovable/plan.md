# Microfinance Convergence — Authoritative Plan (reworked 2026-09-03, 12:2x UTC)

One institution, employee-operated microfinance platform built on the existing
codebase. Reuse proven engines; carry no ERP domain logic forward.

## Reuse decisions (final — do not re-litigate)

KEEP as infrastructure: auth/PIN + invite engine, document generation engine,
navigation/app shell + UI system, Chart of Accounts / journals / GL / fiscal
periods, banking + bank reconciliation, the payment/settlement + allocation
engine, fixed assets, audit logging, reporting engine, storage/file handling.

ADAPT (microfinance wording and data, same engine): receipts and settlement →
loan repayment receipts and disbursement confirmations; customer statement →
client statement and loan statement; receivables ageing → arrears / PAR;
deposits → officer collection banking of daily cash and mobile-money.

OUT (removed or left inactive): sales, purchases, POS, inventory/products,
warehouse, CRM, projects, HR, payroll, recruitment, attendance, timesheets,
marketplace/entitlements, multi-tenancy, client portal.

## Verified state (checked this session)

- `src/apps` = dashboard, finance, lending, platform, reports, studio only.
  Sales/purchases/POS/inventory/HR/payroll app trees are gone.
- `src/pages` and `src/features` hold only platform + finance + auth surfaces;
  no ERP sales/purchase/inventory pages remain.
- Backend microfinance domain live: 23 `mf_*` tables (clients, groups +
  members, loan products + versions, applications, assessments, loans,
  schedule, disbursements, events, repayments, allocations, batches,
  collection activities, account mappings, allocation policy, event postings)
  plus derived views (`mf_loan_balances`, `mf_loan_arrears`,
  `mf_loan_installment_status`, `mf_par_summary`, `mf_client_statement`).
  Financial authority is in the database, not the browser.
- Lending frontend complete for: clients, groups, products/versions,
  applications (form → assessment → decision), loans (create, disburse,
  schedule, lifecycle), repayments, collections, 5 reports, accounting
  mappings, documents through the shared engine.
- C12 RBAC gating and C13 accounting integration (`mf_post_event` →
  `mf_resolve_account` → `post_journal_entry_atomic`) verified DONE.
- C15a ERP surface strip DONE: permission modules trimmed to
  contacts/financials/lending/settings/team; app catalogue exposes Lending as a
  core app, all ERP/HR apps unavailable and hidden.

## Milestones — one at a time, verify before advancing

### C14 — Cash & settlement retarget — DONE

1. Cash receipt path (branch cashier / officer field collection / mobile money)
   lands as `mf_repayment` and posts via `mf_post_event` against the configured
   cash/bank/mobile-money account. DONE.
2. Officer collection sheet + batch banking on `mf_repayment_batches`:
   permission-gated "Bank collections" on a closed, unbanked batch, "Banked"
   indicator and a "Banked collections" table in `RepaymentsPage`. DONE.
3. Group vs individual share one allocation policy, one code path, no frontend
   math. DONE.
4. Client statement through the shared document engine: snapshot
   (`fetchAndBuildClientStatementSnapshot`), `client_statement` →
   `lending.client_statement` in `resolveSourceDocumentRecord`, PDF layout +
   renderer entry, `document_kinds` + default `document_template_ast` seeded
   (migration 2026-09-03), and surfaced via `LendingDocumentsMenu` on the
   clients list and on `ClientStatementReport`. DONE — typecheck green.
5. Reconciliation: microfinance receipts/disbursements are matchable in the
   existing bank reconciliation, no ERP invoice/bill terms in the UI. DONE.

Remaining verification (do at C15b close-out, not as separate work): one live
pass of record → close batch → bank → reconcile and one client-statement render.

Scope guard held: adapted existing banking/settlement services and screens only.
No new engine, no schema duplication, no savings product.


### C15c — Dashboard retarget — DONE (2026-09-03)

- `src/pages/Dashboard.tsx` rebuilt as the microfinance command center:
  KPIs (portfolio outstanding, arrears, PAR 30, collected today, disbursed
  today, open applications, active clients), worst-arrears table and today's
  receipts. Every figure from `mf_loan_balances`, `mf_loan_arrears`,
  `mf_par_summary`, `mf_repayments`, `mf_loan_disbursements`; permission-gated
  via `usePermissions`.
- `QuickActions` and `QuickStats` (launcher `/`) retargeted to lending +
  finance/banking + lending reports. No sales/purchases/inventory/HR entries.
- Removed now-unreferenced ERP dashboard widgets: SalesSummary, Receivables,
  CashFlow, ProfitMargin, ExpenseCategories, BankBalance, CreditAlert,
  Backorder, UpcomingDeadlines, BranchComparison, ExecutiveDashboard +
  `components/dashboard/executive/*`, DashboardCommandStrip, DashboardCreateBar,
  DashboardScopeBadge, ActivityFeed; and hooks `useQuickStatsCounts`,
  `useUpcomingDeadlines`. `DashboardSetupGuide` retained (FinanceDashboard uses it).
- Verification: typecheck green after each step.

### C15b — Dead-code strip & hardening (LAST — NEXT MILESTONE)

- Remove ERP-only pages/services/features not reachable from dashboard,
  finance, lending, platform, reports, studio — confirm by import graph first.
  Known candidates still present: `useDashboardStats`/`useDashboardAnalytics`
  (ERP revenue/expense math, only reachable from AIInsightsWidget and
  `useDashboardComposition`) and the module/entitlement gating they carry.
- Prune `src/parked-modules.d.ts` stubs no retained file needs.
- Close-out: typecheck, build, permission/RLS pass, one full loan lifecycle
  (apply → approve → disburse → repay → arrears → close/write-off), one report
  render, one document render, one record → close batch → bank → reconcile pass,
  one client-statement render.

## Rules

- No payroll, HR product, multi-tenancy, client portal, or ERP workflow revival.
- Never a second implementation where a mature engine exists — adapt it.
- No frontend-authoritative financial math; balances, interest, arrears and
  allocations come from the database.
- Do not investigate, document, or polish anything outside microfinance scope.





======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================


Your Supabase project is already connected (ref `xwxqunklduknceoryrha`), so no reconnection was needed. Per the plan's remaining scope I did the dashboard retarget and its dead-code strip:

- `/dashboard` is now the microfinance command center: portfolio outstanding, arrears, PAR 30, collected today, disbursed today, open applications, active clients, plus a worst-arrears table and today's receipts — all read from the server-owned `mf_*` views/event tables, permission-gated.
- Launcher `/` quick actions and stats retargeted to Clients / Applications / Loans / Repayments / Collections / Accounting / Banking / Lending reports — no products, invoices, bills, inventory or payroll entries.
- Deleted the 15 now-unreferenced ERP dashboard widgets (sales summary, receivables, cash flow, profit margin, expense categories, executive suite, backorders, deadlines, etc.) and 2 orphaned hooks; typecheck and build green.
- Plan updated: next milestone is C15b — the final ERP dead-code strip (starting with `useDashboardStats`/`useDashboardAnalytics` and the parked-module stubs) and the lifecycle/report/document hardening pass.


ALSO FOR THE DASHARD /dashboard --> "Empty" is expected right now, not a bug: the command center reads only from the mf_* tables/views, and this fresh Smart Grow Empowerment database has no loan data yet — no clients, applications, loans, repayments or disbursements, so every KPI is zero and both tables show their empty states.

What remains, in order:

Seed the operating baseline (needed before anything renders): loan product(s) + versions, accounting mappings, and a first client — then run one real flow through the UI (client → application → approve → disburse → repayment) so the dashboard, arrears/PAR and reports have data.
Verify the dashboard against that data — confirm PAR 30's semantics in mf_par_summary (amount vs percentage) so the KPI label matches the view.
C15b (last milestone) — strip the remaining ERP dead code (useDashboardStats, useDashboardAnalytics, the entitlement/module gating they carry, and stale src/parked-modules.d.ts stubs) after import-graph confirmation, then the close-out pass: typecheck, build, permission/RLS check, full loan lifecycle, one report render, one document render, and record → close batch → bank → reconcile.
Minor: a hydration mismatch is logged on the shell (pre-existing, unrelated to the dashboard content) — worth fixing during hardening.
I'd suggest starting with step 1, since it also doubles as the lifecycle verification C15b needs.

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
