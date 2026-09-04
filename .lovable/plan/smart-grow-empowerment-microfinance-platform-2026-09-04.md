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
