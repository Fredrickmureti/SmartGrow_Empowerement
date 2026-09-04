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

Re-verified 2026-09-04 by grep, previous residue list corrected:
- Sales/purchase code residue: GONE. `fetchARSummary`, `fetchAPSummary`,
  `confirmInvoiceGL`, `confirmBillGL`, `RecordCustomerPaymentDialog`,
  `ContactPreviewDrawer` return zero hits in `src/`.
- FX surface residue: GONE. `useFxRevaluation`, `useFxExposure` and
  `fx-tenant-isolation.test.ts` return zero hits. M6 is therefore closed.
- Still in the database and still referenced by shared code: `contacts`
  (22 files — journal counterparty, command palette, entity resolver, studio
  entity catalogue, dashboard composition), `projects` (9 files, all catalogue /
  permission lists), `cost_layers`, `backorders`, `carriers`, `payments` /
  `payment_allocations` (9 files).
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

### M5 — Dead ERP table groups (IN PROGRESS: sales chain DONE, purchasing chain DONE)
One migration per group, FK-ordered, code references deleted in the same step.
Remaining order, cheapest-and-safest first:
1. `cost_layers` + lineage/consumptions, `backorders`, `carriers` — 1 code
   reference each, no shared surface. One migration, one code sweep.
2. `projects` (+ `analytic_*` project bindings if orphaned) — 9 references, all
   app-catalogue / permission / query-key lists. Delete the catalogue entries.
3. `payments` / `payment_allocations` — ERP customer receipts; nothing in the
   lending flow writes them. Confirm `useGovernedEntityOptions`,
   `useClearableRecordedPayments`, `useFiscalPeriodDetail` first, then drop.
4. `contacts` — LAST, because it is welded into shared surfaces: journal-entry
   counterparty (`JournalLineRow`, `financeJournalEntry` snapshot), command
   palette (`providers/customers.ts`, `buildIndex`), `entityResolver`,
   `contactHierarchy`/`contactAddresses`, studio entity catalogue, dashboard
   composition, permissions. Decision required before executing: either point
   journal counterparty at `mf_clients` or drop the counterparty field entirely.
Inert welded groups stay. Verify object counts after each migration.

### M6 — FX surface purge — DONE (verified 2026-09-04, zero references remain)

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
### 2026-09-04 — Plan re-verified against the codebase; M5 step "logistics/costing" DONE.
Verification corrected two stale claims: the sales/purchase code residue and the
whole FX surface (`useFxRevaluation`, `useFxExposure`, `fx-tenant-isolation.test.ts`)
no longer exist — M6 closed with no work.
Migration dropped: `cost_layers`, `cost_layer_consumptions`, `cost_layer_lineage`,
`sales_return_cost_allocations`, `backorders`, `carriers`, plus
`delivery_notes.carrier_id`. Code: removed the `/settings/carriers` nav entry (and
its unused `Truck` icon) and the `backorders` dashboard widget id and its two role
slot lists. Typecheck clean, `GET /` → 200 (a 500 seen mid-run was a stale Vite dep
optimizer state after a lockfile change, cleared by a dev-server restart).
Noted for later, not actioned: `useDashboardComposition` still carries ERP widget
ids (`sales.*`, `inventory.*`, `hr.*`, `payroll.*`, `purchases.*`, `lowStock`,
`creditAlerts`) — one focused sweep, best done with M5 step 3.
Next: M5 step 2 — drop `projects` and delete its 9 catalogue/permission references.

### 2026-09-04 — M5 step 2 DONE: purchasing / vendor-billing chain dropped.
Dropped tables: bills, bill_items, bill_grn_matches, bill_match_exceptions,
bill_match_results, bill_match_tolerance_policies, bill_payments,
bill_payment_allocations, bill_payment_reversal_events, vendor_credit_notes(+items,
applications), vendor_credit_balances, vendor_credit_movements, vendor_refunds,
vendor_statements, vendor_statement_send_jobs. Dropped views: vendor_credit_tieout,
vendor_ledger_entries, vendor_unapplied_advances. Dropped ~80 bill_/vendor_ routines
(atomics, guards, numbering, AP summaries, PO billed-state sync, reset_module__
purchases/vendor_returns). Detached retained tables: `payments.bill_id` and
`bank_reconciliation_matches.matched_bill_payment_id` columns removed, and the two
live trigger functions (`validate_bank_reconciliation_match_scope`,
`validate_bank_transaction_accounting_scope`) rewritten without supplier-payment
branches. Code: deleted `OrgDataResetTool`, `ResetWorkspaceDialog` and their
`WorkspaceSettings` usage, the vendor-credit/AP-aging architecture tests, and the
`bills` / `bill_payments` realtime handlers. Typecheck clean, `GET /` → 200.
Linter count 2,011 → 1,888 — all inherited posture, still deferred to M8.
Next in M5: CRM `contacts` (with `ContactPreviewDrawer` and remaining AR/AP helpers),
then projects, cost layers, backorders/carriers, then `payments` /
`payment_allocations` (confirm readers `useGovernedEntityOptions`,
`useClearableRecordedPayments`, `useFiscalPeriodDetail` first).
### 2026-09-04 — M5 step 1 DONE: sales/AR chain dropped from the database.
Dropped tables: invoices, invoice_items, invoice_additional_costs, credit_notes,
credit_note_items, credit_note_applications, estimates, estimate_items,
estimate_additional_costs, estimate_status_events, proforma_invoices,
proforma_invoice_items, customer_credit_balances, customer_credit_movements,
customer_refunds, customer_statements, customer_statement_send_jobs,
dunning_levels, ar_disputes, ar_promises_to_pay. Dropped views:
finance_ar_open_items, finance_ar_net_position(_by_currency),
finance_open_items_tieout, finance_ar_customer_credit, customer_credit_tieout,
customer_ledger_entries, ar_subledger_entries, v_invoice_creditable_qty,
v_sales_return_settlement, v_sales_returnable_qty. Detached retained tables by
dropping their invoice/estimate/credit-note FK columns (payments,
payment_allocations, mpesa_c2b_transactions, transactions, delivery_notes,
sales_orders, sales_returns, sales_return_items, recurring_invoice_runs) — none
of those columns were read by app code.
Also removed the dead `bill_payment` bank-match kind from
`useBankMatchCandidates` (left over from the supplier-clearing branch deletion).
Post-state: 299 public tables, 44 views. Typecheck clean, `GET /` → 200.
Next in M5: purchasing chain (bills, bill_items, bill_payments +
allocations/matching/reversal events, vendor credits/refunds/statements and the
vendor_* views), then CRM `contacts`, projects, cost layers,
backorders/carriers, then `payments`/`payment_allocations` (ERP customer
receipts — nothing in the microfinance flow writes them; confirm the three
remaining readers first: `useGovernedEntityOptions`,
`useClearableRecordedPayments`, `useFiscalPeriodDetail`).
Linter note: the 2,011 findings are inherited AccrualFlow posture, not caused by
this migration. They stay deferred to M8, scoped to retained schema only.
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



THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT  (Remaining)
===================================================

Dropped the Projects module: the `projects` table and its dependent triggers/functions (`trg_je_line_to_project_ledger`, `_default_analytic_from_project`, `trg_expense_to_cost`) are gone, along with the now-unused `project_id` columns on journal entry lines, expenses and the legacy sales tables. Code side, I removed all 9 catalogue/permission references — permission keys and module map in `permissions.ts`, `queryKeys.projects`, resource-centre app options, module-app map, command index, AI working context and prompts, studio entity catalogue, and the onboarding app grouping. The route typecheck is clean and `/` returns 200.

Remaining (not done): a broader typecheck across `src/lib` and `src/components` was blocked by a config issue in my scratch tsconfig — worth one verification pass next time before moving to M5 step 3 (`payments`/`payment_allocations`), then the `contacts` decision. The Supabase linter warnings shown are the inherited AccrualFlow posture (M6 hardening), not new.