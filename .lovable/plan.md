# Smart Grow Empowerment — Microfinance Platform

Authoritative execution plan. Backend: Supabase `xwxqunklduknceoryrha` (already
connected; nothing to reconnect). One institution, employee-operated, ASA-style
group lending with individual client payments. No multi-tenancy, no client
portal, no payroll.

## Locked decisions (do not re-litigate)

Reused as platform foundation, retargeted to lending: document generation engine ·
auth / PIN / invitation engine · navigation, app shell, UI system · report engine ·
company/institution settings · audit logging · storage · finance core (Chart of
Accounts, journals, GL, fiscal periods, fixed assets, banking + reconciliation) ·
payment settlement engine — used for money in/out spoken as loan repayments,
disbursements and institutional expenses, never as customer invoices or vendor bills.

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, consolidation, multi-tenancy, client portal, FX reporting.

Invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group, FK-ordered, verified before the next.
- No second implementation where a mature engine exists; retarget, don't rebuild.

## Verified state (2026-09-04, read from the codebase)

- Apps: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages under `src/pages` or `src/apps`.
- Lending domain live end-to-end: clients, groups, versioned products,
  applications, assessment/approval, loans, disbursement, schedule engine,
  repayments (group collection sheet + single-client payment through the single
  `mf_record_repayment` RPC, reversal via `mf_reverse_repayment`), collections,
  arrears/PAR, top-up / restructure / write-off / closure as distinct events,
  penalty allocation by policy order, officer data scope, duplicate guards.
- Report registry: 23 entries, categories `lending, statutory, cash_bank, audit,
  management, fixed_assets` only. Every `/finance/reports/*` route maps to an entry.
- Statements/receipts are microfinance: lending Client Statement; receipts project
  loan + installment allocations server-side.
- Dashboard/KPI surfaces read lending sources; ERP dashboard hooks deleted (M3).
- DB slimming executed: consolidation, HR extras, retail/POS, warehouse,
  scanner/workstation, sales pricing engine.

Confirmed remaining ERP residue (scoped below, not open questions):
- `useJournalBooks` still exposes `sale`/`purchase` journal types; default seeding
  creates Sales (SAL) and Purchases (PUR) books that no entry uses.
- `useDefaultAccounts` / `DefaultAccountsConfig` still surface inventory, COGS,
  inventory adjustment, POS cash over/short, card clearing, customer deposits and
  FX gain/loss roles, while the lending roles that exist in the DB (loan
  receivable, interest income, disbursement clearing, write-off expense) are not shown.
- Sales/purchase code still live: `fetchARSummary`/`fetchAPSummary`,
  `confirmInvoiceGL`, `confirmBillGL`, `RecordCustomerPaymentDialog`,
  `ContactPreviewDrawer`, consumers in `OnboardingChecklist`, `pages/Reports.tsx`.
- FX hooks/tests still in the tree: `useFxRevaluation`, `useFxExposure`, call sites
  in `ClosePeriodSheet.tsx`, `FinanceAccountingControls.tsx`,
  `fx-tenant-isolation.test.ts`, `src/lib/reports/branchScopability.ts`.
- Inert by decision (identifiers welded into shared document/outbox/audit/studio
  metadata; removal costs more than it returns): delivery notes, sales orders,
  sales returns, recurring invoices, eTIMS.

## Milestones — one at a time, verified before the next

### M1 — Owner verification pass (open, runs in parallel)
The sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and PAR
render; one lending report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine.

### M2 — Report catalogue retargeting — DONE
### M3 — Money-in/money-out retargeting — DONE (2026-09-04)

### M4 — Finance configuration retargeting (NEXT, code-only, no migration)
Finishes the pass the previous engineer left open.
1. `useJournalBooks`: `JournalType` reduced to `bank | cash | general`; default
   seeding creates microfinance books — Disbursements, Collections, Bank, Cash,
   Miscellaneous; existing SAL/PUR books deactivated rather than deleted (13
   existing entries all sit in Miscellaneous, so nothing is orphaned).
2. `FinanceAccountingControls` journal type picker follows the reduced set.
3. `useDefaultAccounts` + `DefaultAccountsConfig`: role list rebuilt around
   lending — loan receivable, interest income/receivable, fee income, penalty
   income, disbursement clearing, write-off expense, cash, bank, mobile money,
   plus retained generic roles (retained earnings, suspense, fixed-asset and
   depreciation roles). Drop inventory, COGS, inventory adjustment, POS
   over/short, card clearing, customer deposits, FX gain/loss. Update
   `default-account-role-coverage` / `-protected` architecture tests to the new set.
Gate: typecheck clean, build OK, `/finance` configuration screens render.

### M5 — Dead ERP table groups (DB slimming)
One migration per group, FK-ordered, code references deleted in the same step:
sales chain (invoices, credit notes, estimates, proforma, customer
credits/statements, dunning, AR disputes) → purchasing chain (bills, bill
payments/matching, vendor credits/refunds/statements) → CRM `contacts` (with
`ContactPreviewDrawer` and the AR/AP open-items helpers/tests) → projects → cost
layers → backorders/carriers. Inert welded groups stay. Verify object counts after
each migration.

### M6 — FX surface purge (code only)
Delete `useFxRevaluation`/`useFxExposure`, their call sites in `ClosePeriodSheet`
and `FinanceAccountingControls`, and `fx-tenant-isolation.test.ts`. Keep
`exchange_rates` and currency plumbing — documents and GL depend on it.

### M7 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches per group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### M8 — Linter posture on retained schema only
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection. Findings on tables dropped in M5 are ignored, not fixed.

### M9 — Microfinance report completion
Fill SRD gaps on the existing report engine (officer/branch collection
performance, disbursement register, product performance, aging/DPD bands),
server-side data, company-info injection, shared PDF path. No new engine.

## Working rules
- Do not audit, document or polish anything outside microfinance scope.
- No frontend-authoritative financial math.
- Reuse the engine, replace the domain data.
- Update this file after each milestone; keep it short and factual.

## Progress log (latest first)
### 2026-09-04 — plan reworked for the new owner: milestones renumbered, the
unfinished journal-books / default-account-mapping retargeting promoted to M4 as
the single next action; ERP residue re-verified from the codebase.
### 2026-09-04 — fiscal-period close tooling retargeted to lending
(`useFiscalPeriodDetail` counts `mf_loan_disbursements` / `mf_repayments`;
Subledgers tab replaced by a Portfolio tab reading `mf_loan_balances`).
### 2026-09-04 — M3 closed: ERP dashboard/invoice/bill hooks deleted, launcher and
dashboard read lending sources, setup guide points at `/lending/clients`.
### 2026-09-04 — statements & settlement: lending Client Statement report; receipts
project loan/schedule/`mf_repayment_allocations` server-side; single
`mf_record_repayment` writer.
### 2026-09-04 — sales pricing engine removed; report catalogue microfinance-only.


==========THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT==============



M4 (finance configuration retargeting) is partly done: journal books are now Bank/Cash/General only with microfinance default seeding (Disbursements, Collections, Bank, Cash, Miscellaneous) and automatic retirement of the legacy Sales/Purchases books; the journal type picker follows suit; Default Account Configuration now lists only institution-level roles (treasury, payables, tax, operating expense, equity, fixed assets, mobile money) with lending mappings deliberately left to Lending → Configuration → Accounting; and the orphaned product GL helpers were deleted.

Remaining for M4: `useDefaultAccounts` still carries the ERP role fields/helpers (invoice/bill/credit-note mappings, inventory/COGS/FX keys) — only `getFixedAssetAccountMappings` is actually consumed, so that hook should be trimmed to the retained roles; then run a typecheck/build pass and update `.lovable/plan.md`. After that the next milestone is M5 (dead ERP table groups, one migration per group).

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
