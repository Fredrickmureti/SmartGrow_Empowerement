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

### M3 — Statements & settlement retargeting completion
Confirm (and finish where partial) that the reused settlement engine speaks
microfinance: statements are **client/loan statements**, not customer invoices;
receipts cite loan + installment allocation; the settlement path used by
repayments is the shared engine, not a lending-local copy. No sales vocabulary in
labels, templates or report titles.

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

### M7 — Domain depth (only on request)
Savings, teller/cash-management sessions, regulatory returns. Out of scope until
the owner asks.

## Working rules
- Do not audit, document or polish anything outside microfinance scope.
- No frontend-authoritative financial math.
- Update this file after each milestone; keep it short and factual.
