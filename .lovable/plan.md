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

### M1 — Owner verification pass (next)
The sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and PAR
render; one lending report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine. Anything
broken here is fixed before M2.

### M2 — FX surface purge (code only, ~1 pass)
Delete the FX hooks, their remaining call sites and the FX-only architecture test;
keep `exchange_rates` and currency plumbing (documents + GL depend on it). Period
close and accounting controls keep their non-FX behaviour. Confirm no registry
entry, nav item or search result mentions FX. Typecheck.

### M3 — Money-in/money-out retargeting (reuse, don't delete)
Repoint the reused settlement/open-items engine at microfinance parties before any
table drops:
- Replace `useInvoices`/`useBills`/`fetchARSummary`/`fetchAPSummary` consumers with
  lending-native sources: receivables = loan outstanding + arrears views;
  payables = institutional expenses.
- `OnboardingChecklist`, dashboard/executive stats and `pages/Reports.tsx` read
  those lending sources.
- `ReconcileTransactionSheet` matches bank lines to repayments, disbursements and
  expenses — not invoices/bills.
- `RecordCustomerPaymentDialog` is replaced by the existing lending repayment path;
  no second payment writer.
- Keep the settlement/allocation engine itself; only its party and document
  vocabulary changes.

### M4 — Dead ERP table groups (DB slimming)
Only after M3 removes the last live consumers. One migration per group, FK-ordered,
code references deleted in the same step: sales chain (invoices, credit notes,
estimates, proforma, customer credits/statements, dunning, AR disputes) →
purchasing chain (bills, bill payments/matching, vendor credits/refunds/statements)
→ CRM `contacts` → projects → cost layers → backorders/carriers. Groups welded into
retained metadata stay inert; record the decision and move on. Verify object counts
after each migration.

### M5 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches per group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### M6 — Linter posture on retained schema only
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes, leaked-password
protection. Findings on tables scheduled for M4 are ignored, not fixed.

### M7 — Microfinance report completion
Fill gaps the SRD requires and the registry lacks (officer/branch collection
performance, disbursement register, product performance, aging/DPD bands) using the
existing report engine, server-side data, company-info injection and the shared PDF
path. No new engine.

## Working rules
- Do not audit, document or polish anything outside microfinance scope.
- No frontend-authoritative financial math.
- Reuse the engine, replace the domain data.
- Update this file after each milestone; keep it short and factual.

## Progress log (latest first)

### 2026-09-04 — plan reworked
Re-verified apps, report registry (23 microfinance-only entries), lending domain and
the single repayment RPC directly from the codebase. Found the FX and sales/purchasing
residue listed above. Reordered the remaining work so retargeting (M3) precedes table
drops (M4) — dropping first would strand live consumers. Added M7 for the missing
microfinance reports.

### 2026-09-04 — M3 (old numbering) closed: statements & settlement
Statements are the lending Client Statement report; receipts project loan, schedule
and `mf_repayment_allocations` server-side; all repayments go through
`mf_record_repayment`. Residual ERP route comments removed. Typecheck clean.

### 2026-09-04 — M2 (old numbering) closed: orphaned report/finance surfaces
FX and stock report route stubs removed from `src/apps/finance/routes.tsx`; POS
enrichment stripped from `AccountingEventsWorkspace.tsx`; nav stays registry-driven.


==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============



I paused mid-M3. Here's where things stand.

Done this pass (typecheck clean with `bunx tsgo --noEmit -p tsconfig.app.json`):
- Deleted dead ERP surfaces with no live consumers: `src/pages/Reports.tsx` (legacy invoice-aging reports page, imported but never rendered), `src/components/onboarding/OnboardingChecklist.tsx`, `src/components/payments/` (`RecordCustomerPaymentDialog`, `AdvancePaymentDialog`), `src/hooks/invoices/`, `src/hooks/bills/` (`confirmInvoiceGL`, `confirmBillGL`, `createInvoiceAtomic`), plus the stale lazy import in `src/apps/finance/routes.tsx`.
- Retargeted `ReconcileTransactionSheet.tsx`: removed the Invoices and Bills tabs, their selection state, allocation math, search copy and `useInvoices`/`useBills` imports. Bank lines now match through the candidate engine, the Recorded (already-recorded payments awaiting banking) tab, Expenses and Journal — the settlement engine and its `reconciled_type` contract are untouched.

Remaining for M3:
1. Add a lending position service (e.g. `src/services/lending/portfolioPosition.ts`) reading server views: `mf_loan_balances` for portfolio outstanding / overdue / DPD bands, `mf_par_summary` for PAR 1/30/90, `mf_loan_arrears` for arrears totals and overdue loan counts; institutional payables from unpaid `expenses` (`status` in pending/submitted/approved).
2. Replace `useARSummary`/`useAPSummary` in `src/hooks/finance/useOpenItemsSummary.ts` with lending-native hooks and repoint `useDashboardStats.ts`, `useDashboardAnalytics.ts`, `useExecutiveStats.ts` (receivables → loan portfolio/arrears; payables → institutional expenses; drop invoice-status collection-rate and top-debtor-from-contacts math).
3. Remove the now-orphaned AR/AP helpers in `src/services/finance/openItems.ts` and the `useInvoices`/`useBills` hooks once step 2 lands.

Then M4 (ERP table drops) can start, since it depends on those last consumers being gone.


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
