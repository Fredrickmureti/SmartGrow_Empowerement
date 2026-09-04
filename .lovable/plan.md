# Smart Grow Empowerment — Microfinance Platform

Authoritative execution plan. Backend: Supabase `xwxqunklduknceoryrha` (connected).
Single institution, employee-operated, ASA-style group lending with individual
payments also supported. No multi-tenancy, no client portal.

## Locked decisions (do not re-litigate)

Reused as platform foundation: document generation engine · auth / PIN /
invitation engine · navigation, app shell, UI system · report engine · company /
institution settings · audit logging · storage · finance core (Chart of Accounts,
journals, GL, fiscal periods, fixed assets, banking + reconciliation, payment
settlement engine) — all retargeted to lending, never to sales.

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, consolidation, multi-tenancy, client portal.

Invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group. Never batch multi-object SQL.
- No second implementation where a mature engine exists.

## Verified state (read from the codebase, 2026-09-04)

- Apps are `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages remain under `src/pages` or `src/apps`.
- Lending domain live end-to-end: clients, groups, products (versioned),
  applications, assessment/approval, loans, disbursement, schedule engine,
  repayments (group collection sheet **and** single-client payment), collections,
  arrears/PAR, top-up / restructure / write-off / closure as distinct events,
  penalties with policy-ordered allocation, officer data scope, reversal and
  duplicate guards.
- Report catalogue is microfinance-only: 24 registry entries across `lending,
  statutory, cash_bank, audit, management, fixed_assets`. FX and aged AR/AP
  entries are out of the registry, nav and search.
- Finance ERP surfaces (receivables, payables routes/pages, customer-invoice and
  vendor-bill dashboard cards, ERP palette actions) removed.
- Studio entity catalogue is microfinance-only (`mf_*`, `employee`, `expense`).
- DB slimming already executed: consolidation group, HR extras, retail/POS
  leftovers, warehouse leftovers, scanner/workstation group, sales pricing engine
  (price lists, customer groups, pricing triggers) — dropped with their code.

Deliberately left inert (no nav, no hooks, no UI; removal costs more than it
returns): delivery notes, sales orders, sales returns, recurring invoices and
eTIMS identifiers embedded in shared document/outbox/audit/studio metadata.

## Remaining milestones — strictly one at a time

### M1 — Owner verification pass (next; blocks nothing)
The sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and
PAR render; one lending report, one client statement, one repayment receipt and
one disbursement confirmation render through the shared document engine. Failures
found here are fixed before M2.

### M2 — Orphaned ERP report/finance surfaces still reachable
Remove the leftovers the catalogue work left behind:
- FX Revaluation, FX Exposure and Realized FX Gain/Loss report pages + routes in
  `src/apps/finance/routes.tsx` and their hooks (`useFxRevaluation`), plus the FX
  references in `src/services/finance/openItems.ts` and the stale doc comment in
  `src/services/reports/reportsNav.ts`. Institution operates in KES; unrealized
  FX reporting has no microfinance consumer.
- Keep `exchange_rates` / currency plumbing (documents and GL depend on it) but
  no FX reporting surface.
- Verify no remaining report category is orphaned: every registry entry must
  resolve to a routed page whose data source is `mf_*`, GL, banking, fixed assets
  or audit. Anything else is deleted, not adapted.

### M3 — Statements & settlement retargeting completion — DONE 2026-09-04
Verified: the reused settlement engine speaks
microfinance: statements are **client/loan statements**, not customer invoices;
receipts cite loan + installment allocation; the settlement path used by
repayments is the shared engine, not a lending-local copy.

Findings: statements are the lending **Client Statement** report
(`src/apps/lending/reports/ClientStatementReport.tsx`); no customer-statement
surface is routed. Receipts project loan, schedule and
`mf_repayment_allocations` (installment_no + component) via
`src/services/documents/snapshots/lending.ts`, computing nothing client-side.
Every repayment write goes through one server RPC, `mf_record_repayment`
(reversal via `mf_reverse_repayment`) — there is no lending-local settlement
copy. Residual Customer/Vendor Credits + Customer Statements route comments in
`src/apps/finance/routes.tsx` removed; finance and lending navs contain no
sales vocabulary. Typecheck clean.

### Next: M4 — dead ERP table groups.

### M4 — Dead ERP table groups (DB slimming, continued)
One migration per group, FK-ordered, code references deleted in the same step:
sales chain (invoices, sales orders/returns, credit notes, delivery notes,
estimates, proforma, recurring invoices, customer credits/statements, dunning, AR
disputes) → purchasing chain (bills, bill payments/matching, vendor
credits/refunds/statements) → CRM `contacts` → projects → cost layers →
backorders/carriers → eTIMS. Keep auth, org/branch, finance core, banking,
documents, reporting, audit, `mf_*`. Verify counts after each migration.
Any group whose identifiers are welded into the retained document/outbox metadata
stays inert rather than being force-dropped — record the decision, move on.

### M5 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches per group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### M6 — Linter posture on retained schema only
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection. Inherited findings on tables scheduled for M4 are
ignored, not fixed.



## Working rules
- Do not audit, document or polish anything outside microfinance scope.
- No frontend-authoritative financial math.
- Update this file after each milestone; keep it short and factual.



## Progress log (latest first)

### 2026-09-04 — M2 closed: orphaned ERP report/finance surfaces
- `src/apps/finance/routes.tsx`: removed the dead FX Revaluation / FX Exposure /
  Realized FX stubs and the Stock Adjustments / Stock Transfers / Inventory⇄GL
  stubs. Every remaining `/finance/reports/*` route (11) is a `REPORT_REGISTRY`
  entry; registry categories are microfinance-only (`lending, statutory,
  cash_bank, audit, management, fixed_assets`) — no FX or inventory category.
- `src/services/reports/reportsNav.ts`: FX/stock wording removed from the doc
  comment; nav stays registry-driven.
- `src/pages/finance/AccountingEventsWorkspace.tsx`: stripped all POS
  enrichment — `pos_statements` summary query, POS dispatcher-health query and
  its column, POS producer label, POS/sale event-kind labels, and the sales
  copy in the page header. Event kinds are now lending events.
- `FinanceDashboard.tsx` invoice/bill RPC counts and `FiscalPeriodDetail.tsx`
  invoice tiles were already removed in the prior session.
- Typecheck clean.

Deferred deliberately: `src/hooks/useInvoices.ts`, `src/hooks/useBills.ts` and
`fetchARSummary`/`fetchAPSummary` still have live consumers (onboarding
checklist, bank reconciliation match sheet, dashboard/executive stats,
`pages/Reports.tsx`). Deleting them is part of **M4 sales/purchasing chain**,
where table drop + code deletion happen in one step. Do not half-delete them.

### Next milestone: M3 — statements & settlement retargeting



==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============

M3 verified and closed: statements are the lending Client Statement report, receipts project loan + installment allocations server-side, all repayments go through the single `mf_record_repayment` RPC, and the last ERP route comments are gone — typecheck clean. M4 (dead ERP table groups) is next.

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
