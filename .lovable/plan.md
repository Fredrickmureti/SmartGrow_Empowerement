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
