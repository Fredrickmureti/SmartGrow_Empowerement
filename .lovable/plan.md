# Smart Grow Empowerment — Microfinance Platform

Authoritative execution plan. Backend: Supabase `xwxqunklduknceoryrha` (already
connected). One institution, employee-operated, ASA-style branch model: group
meetings as the collection point, individual client obligors, no joint liability.
No multi-tenancy, no client portal, no payroll.

## Locked decisions (do not re-litigate)

Reused as platform foundation, retargeted to lending: document generation engine ·
auth / PIN / invitation engine · navigation, app shell, UI system · report engine ·
company/institution settings · audit logging · storage · finance core (Chart of
Accounts, journals, GL, fiscal periods, fixed assets, banking + reconciliation) ·
payment settlement engine — money in/out spoken as loan repayments, disbursements
and institutional expenses, never customer invoices or vendor bills.

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, consolidation, multi-tenancy, client portal, FX reporting.

Invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group, FK-ordered, verified before the next.
- Retarget mature engines; never write a second implementation.

## Verified state (2026-09-04, read from the codebase)

- Apps: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages under `src/pages` or `src/apps`.
- Lending domain live end-to-end: clients, groups, versioned products,
  applications, assessment/approval, loans, disbursement, schedule engine,
  repayments (group collection sheet + single-client payment through the single
  `mf_record_repayment` RPC, reversal via `mf_reverse_repayment`), collections,
  arrears/PAR, top-up / restructure / write-off / closure as distinct events,
  policy-ordered allocation, officer data scope, duplicate guards.
- Report registry: 23 entries, categories `lending, statutory, cash_bank, audit,
  management, fixed_assets` only. Every `/finance/reports/*` route maps to an entry.
- Statements/receipts are microfinance: lending Client Statement; receipts project
  loan + installment allocations server-side.
- Fiscal-period close tooling reads lending sources (`mf_loan_disbursements`,
  `mf_repayments`, `mf_loan_balances`).
- Finance configuration retargeted: journal types `bank | cash | general`, books
  seeded as Disbursements/Collections/Bank/Cash/Miscellaneous (legacy SAL/PUR
  deactivated); default account roles reduced to institution-level only.
- DB slimming already executed: consolidation, HR extras, retail/POS, warehouse,
  scanner/workstation, sales pricing engine.

Confirmed remaining ERP residue (scoped below, not open questions):
- Sales/purchase code still live: `fetchARSummary`/`fetchAPSummary`,
  `confirmInvoiceGL`, `confirmBillGL`, `RecordCustomerPaymentDialog`,
  `ContactPreviewDrawer`, consumers in `OnboardingChecklist`, `pages/Reports.tsx`.
- FX hooks/tests still in the tree: `useFxRevaluation`, `useFxExposure`, call sites
  in `ClosePeriodSheet.tsx`, `FinanceAccountingControls.tsx`,
  `fx-tenant-isolation.test.ts`, `src/lib/reports/branchScopability.ts`.
- Dead ERP table groups still in the database (M5).
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
### M4 — Finance configuration retargeting — DONE (2026-09-04)
Journal types/books, journal-type picker, `DefaultAccountsConfig` role list, and
`useDefaultAccounts` all reduced to the retained institution roles (cash, bank,
mobile money, M-Pesa, payables, input/output tax, operating expense, retained
earnings, opening-balance equity, other income, fixed asset, accumulated
depreciation, depreciation expense). ERP helpers deleted: invoice / bill /
credit-note / customer-payment mapping getters, inventory, COGS, inventory
adjustment, card clearing, customer deposits, customer credit, sales revenue,
`hasRequiredAccounts` / `hasPaymentAccounts` / `hasBillingAccounts`. No callers
remained. Typecheck clean, `GET /` → 200.

### M5 — Dead ERP table groups (NEXT, DB slimming)
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
### 2026-09-04 — M4 closed: `useDefaultAccounts` trimmed to institution roles;
all ERP mapping getters removed with zero remaining callers.
### 2026-09-04 — journal books + default-account config retargeted; orphaned
product GL helpers deleted.
### 2026-09-04 — plan reworked for the new owner: milestones renumbered, ERP
residue re-verified from the codebase.
### 2026-09-04 — fiscal-period close tooling retargeted to lending.
### 2026-09-04 — M3 closed: ERP dashboard/invoice/bill hooks deleted.
### 2026-09-04 — statements & settlement: lending Client Statement; receipts
project loan/schedule/`mf_repayment_allocations`; single `mf_record_repayment` writer.
### 2026-09-04 — sales pricing engine removed; report catalogue microfinance-only.



THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT
===================================================



I'll start by checking what actually exists — the plan file, the codebase, and the connected database state — before deciding anything.

Paused before the database change landed — here's exactly where things stand.

Backend connection: your app is already wired to the `Smart Grow Empowerment` project (`xwxqunklduknceoryrha`); nothing needed connecting.

Verified this session (no assumptions carried over):
- 31 `mf_*` lending tables live, lending app in place, report catalogue microfinance-only.
- 19 dead ERP table groups still in the database; M5 is genuinely where the previous engineer stopped.
- Zero live app code reads any of those ERP tables — only edge-function branches that run for ERP document types.

Code changes made (M5 steps 1–2, build was green before the DB step):
- Deleted orphaned sales/AR code: `ContactPreviewDrawer`, `services/finance/openItems.ts`, `aging.ts`, `createCreditNote.ts`, `useAgingReport.ts`, and the two AR/AP tests; trimmed three architecture tests accordingly.
- `useClearableRecordedPayments` + `ReconcileTransactionSheet`: removed the supplier bill-payment clearing branch (money-out now reconciles via Expenses / account offset / transfer). This was the only blocker to dropping the purchasing chain.

Migration attempt failed (not applied): Postgres rejected the migration with `cannot drop column invoice_id of table payment_allocations because other objects depend on it` — the ERP views `finance_ar_open_items`, `finance_ar_net_position`, `finance_ar_net_position_by_currency`, `finance_open_items_tieout` sit on that column. The whole migration rolled back; the database is unchanged.

Exact next step (one small fix, then re-run): prepend `DROP VIEW IF EXISTS public.finance_open_items_tieout, public.finance_ar_net_position_by_currency, public.finance_ar_net_position, public.finance_ar_open_items CASCADE;` to the same migration and re-apply. Then verify object counts, run the typecheck, and update `.lovable/plan.md` to record M5 as done and log the decision that `payments`/`payment_allocations` (customer receipts) are the next candidate group since nothing in the microfinance flow writes to them.

After that, M6–M9 in the plan remain untouched as scoped.