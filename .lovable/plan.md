# Smart Grow Empowerment — Microfinance Platform

Authoritative execution plan. Backend: Supabase `xwxqunklduknceoryrha` (connected).
One institution, employee-operated, ASA-style group lending plus individual
payments. No multi-tenancy, no client portal, no payroll.

## Locked decisions (do not re-litigate)

Reused as platform foundation, retargeted to lending: document generation engine ·
auth / PIN / invitation engine · navigation, app shell, UI system · report engine ·
company/institution settings · audit logging · storage · finance core (Chart of
Accounts, journals, GL, fiscal periods, fixed assets, banking + reconciliation) ·
payment settlement engine — reused for money in/out, spoken as loan repayments,
disbursements and institutional expenses, never as customer invoices or vendor bills.

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, consolidation, multi-tenancy, client portal, FX reporting.

Invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group, FK-ordered, verified before the next.
- No second implementation where a mature engine exists.
- Reuse-before-delete: a solid engine gets retargeted, not rebuilt.

## Verified state (2026-09-04, read from the codebase)

- Apps: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages under `src/pages` or `src/apps`.
- Lending domain live end-to-end: clients, groups, versioned products,
  applications, assessment/approval, loans, disbursement, schedule engine,
  repayments (group collection sheet + single-client payment via the single
  `mf_record_repayment` RPC, reversal via `mf_reverse_repayment`), collections,
  arrears/PAR, top-up / restructure / write-off / closure as distinct events,
  penalty allocation by policy order, officer data scope, duplicate guards.
- Report registry: 23 entries, categories `lending, statutory, cash_bank, audit,
  management, fixed_assets` only. No FX, no aged AR/AP, no inventory category.
  Every `/finance/reports/*` route maps to a registry entry.
- Statements/receipts are microfinance: lending Client Statement report; receipts
  project loan + installment allocations server-side.
- DB slimming already executed: consolidation, HR extras, retail/POS, warehouse,
  scanner/workstation, sales pricing engine.

Known residue (scoped into milestones below, not open questions):
- FX hooks/tests still in the tree: `src/hooks/finance/useFxRevaluation.ts`,
  `useFxExposure.ts`, references in `ClosePeriodSheet.tsx`,
  `FinanceAccountingControls.tsx`, `src/test/architecture/fx-tenant-isolation.test.ts`,
  `src/lib/reports/branchScopability.ts`.
- Sales/purchasing code still live: `useInvoices`, `useBills`,
  `fetchARSummary`/`fetchAPSummary`, `confirmInvoiceGL`, `confirmBillGL`,
  `RecordCustomerPaymentDialog`, consumers in `OnboardingChecklist`,
  `ReconcileTransactionSheet`, dashboard/executive stats, `pages/Reports.tsx`.
- Inert-by-decision (identifiers welded into shared document/outbox/audit/studio
  metadata; removal costs more than it returns): delivery notes, sales orders,
  sales returns, recurring invoices, eTIMS.

## Milestones — one at a time, verified before the next

### M1 — Owner verification pass (open, runs in parallel)
The sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and PAR
render; one lending report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine.

### M2 — Report catalogue retargeting — DONE
Registry is microfinance-only (23 entries): lending, statutory, cash_bank, audit,
management, fixed_assets. FX, aged AR/AP, inventory, HR, POS families removed from
the catalogue, nav and search. FX *code* purge is tracked as M7.



### M3 — Money-in/money-out retargeting — DONE (2026-09-04)
Verified from the codebase: the home launcher (`QuickStats`) and `pages/Dashboard.tsx`
already read lending sources (`useMfPortfolioReport`, `useMfArrears`,
`useMfCollectionsReport`, `useMfClients`), so no new position service was needed.
Deleted the remaining ERP-only consumers, which had no live render path:
`useDashboardAnalytics`, `useDashboardStats`, `useExecutiveStats`,
`AIInsightsWidget`, `useInvoices`, `useBills`, `useOpenItemsSummary`, plus the two
architecture tests bound to the deleted hooks. `useDashboardComposition` no longer
reads invoice stats; its setup gaps are now bank / clients / chart of accounts, and
`DashboardSetupGuide` points the first CTA at `/lending/clients`.
`ReconcileTransactionSheet` (retargeted earlier) and the settlement/allocation engine
are untouched. Typecheck clean, build OK, preview 200 (a stale
`@tanstack/router-core` SSR mismatch surfaced during the pass and was cleared).
AR/AP summary RPC helpers remain in `services/finance/openItems.ts` for the contact
drawer and the AR/AP architecture tests; they drop with the sales/purchase chain in M4.

### M4 — Dead ERP table groups (DB slimming) — next
One migration per group, FK-ordered, code references deleted in the same step: sales
chain (invoices, credit notes, estimates, proforma, customer credits/statements,
dunning, AR disputes) → purchasing chain (bills, bill payments/matching, vendor
credits/refunds/statements) → CRM `contacts` (with `ContactPreviewDrawer` and the
AR/AP open-items helpers/tests) → projects → cost layers → backorders/carriers.
Groups welded into retained document/outbox/audit/studio metadata stay inert. Verify
object counts after each migration.

### M5 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches per group. Never touch `mf_*`. Confirm no trigger on a live
table depends on a function before dropping it.

### M6 — Linter posture on retained schema only
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes, leaked-password
protection. Findings on tables dropped in M4 are ignored, not fixed.

### M7 — FX surface purge (code only)
Delete `useFxRevaluation`/`useFxExposure`, their call sites in `ClosePeriodSheet` and
`FinanceAccountingControls`, and `fx-tenant-isolation.test.ts`. Keep `exchange_rates`
and currency plumbing — documents and GL depend on it.

### M8 — Microfinance report completion
Fill SRD gaps the registry lacks (officer/branch collection performance, disbursement
register, product performance, aging/DPD bands) on the existing report engine,
server-side data, company-info injection, shared PDF path. No new engine.

## Working rules
- Do not audit, document or polish anything outside microfinance scope.
- No frontend-authoritative financial math.
- Reuse the engine, replace the domain data.
- Update this file after each milestone; keep it short and factual.

## Progress log (latest first)

### 2026-09-04 — M3 closed (see above). Next: M4 sales-chain migration.
### 2026-09-04 — plan reworked; report catalogue already microfinance-only
(23 entries; categories lending, statutory, cash_bank, audit, management,
fixed_assets — FX, aged AR/AP, inventory, HR, POS families removed from registry,
nav and search).
### 2026-09-04 — statements & settlement: lending Client Statement report; receipts
project loan/schedule/`mf_repayment_allocations` server-side; single
`mf_record_repayment` writer.
### 2026-09-04 — sales pricing engine removed (line-pricing triggers, price lists,
customer groups); orphaned FX/stock report route stubs removed.



==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============
I paused mid-way through the fiscal-period cleanup. Here's where things stand:

Done so far
- `ClosePeriodSheet.tsx` — draft-invoice readiness removed; journal-entry readiness retained.
- `parseQuery.ts` + tests — ERP aliases replaced with client/member/borrower; 10 tests pass.
- `selfActionCatalogue.ts` and `useGovernedEntityOptions.ts` — bill / bill-payment governance removed; payment, journal-entry, expense, bank-account governance retained.
- `useFiscalPeriodDetail.ts` — partially converted: `transactionCounts` now uses disbursements/repayments, the AR/AP `subledger` block is replaced by a `portfolio` summary (outstanding, overdue, loan count, loans in arrears), and close-readiness now flags loans in arrears instead of draft invoices/bills.

Still outstanding (file currently won't typecheck until finished)
1. `useFiscalPeriodDetail.ts` — replace the query legs (lines ~191–391): drop `invoicesResult`, `draftInvoicesResult`, `billsResult`, `draftBillsResult`, `arResult`, `arOverdueResult`, `apResult`, `apOverdueResult`; add `disbursementsResult` (`mf_loan_disbursements`, `disbursed_on` in period), `repaymentsResult` (`mf_repayments`, `paid_on` in period) and `portfolioResult` (`mf_loan_balances` by business). Also update the `TransactionCounts` / `SubledgerSummary` interfaces (lines 27–36, 64–71 → `LoanPortfolioSummary` with `outstanding`, `overdue`, `loanCount`, `overdueLoanCount`), the `subledger` field in `FiscalPeriodDetailData` (line 120), and the header comment on line 6.
2. `src/pages/finance/FiscalPeriodDetail.tsx` — rename the Subledgers tab to a Loan Portfolio card using the new `portfolio` fields (lines ~514–567) and swap the Bills/Draft Bills tiles for Disbursements/Repayments (lines 336–337).
3. Then the remaining M4 items: `TransactionPreviewDrawer.tsx`, `openItems.ts`, `ContactPreviewDrawer.tsx`, AR/AP architecture tests, and only afterwards the first FK-ordered sales-chain migration.

Run a typecheck first thing when you resume — the hook is in an inconsistent state until step 1 is complete.

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

## Status update (M3, pricing group)

Done: removed the sales pricing engine — line-pricing triggers on invoice /
estimate / credit-note / proforma / sales-order items, `_pricing_normalize_line`,
`resolve_line_unit_price`, `pos_resolve_line`, the `contacts.customer_group_id`
and `contacts.price_list_id` columns, and the `customer_groups`, `price_lists`,
`price_list_items` tables. Code side (`fetchContactDefaults`, `useContacts`)
cleaned; typecheck green. Linter count 2025 -> 2021, all inherited, none new.

Scope decision (deliberate, to avoid credit burn): delivery notes, sales orders,
recurring invoices, sales returns and the eTIMS group are NOT worth a deep
schema scrub — their identifiers are woven through the shared document engine,
outbox, audit and studio metadata that we are keeping. They are left inert
(no navigation, no hooks, no UI). Next work goes to microfinance business logic:
retargeting receivables/payables and the payment settlement engine to loans,
group/individual collections, and microfinance-tailored statements.

## Report catalogue retargeted to microfinance (done 2026-09-04)

- `REPORT_REGISTRY` categories/domains reduced to microfinance-relevant sets:
  categories are now lending, statutory, cash_bank, audit, management,
  fixed_assets; domains are finance + lending only (hr/sales/purchases/
  inventory/pos/projects/crm removed).
- Removed orphaned ERP reports from the catalogue, nav and search: FX
  Revaluation, FX Exposure, Realized FX Gain/Loss, Aged Receivables, Aged
  Payables (the FX *pages/routes* stay only because period-close tooling links
  to them; they are no longer part of the report catalogue).
- Added the remaining lending reports to the registry (officer & branch
  collections, PAR aging, product performance, client exposure) so palette,
  favorites, run history and permissions apply to them.
- Reports sidebar now leads with a "Lending & portfolio" family; the FX and
  Receivables/Payables families are gone. Report Center quick access defaults
  to portfolio / arrears / collections.





DO NOT ASK ME ACHITECTURAL QUESTIONS , YOU ARE THE ENGINEER, YOU HAVE THE CODEBASE, YOU KNOW WHATW E ARE BUILDING SO REASON CRITICALLY AND ANALYTICALLY 
