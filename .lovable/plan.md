# Smart Grow Empowerment — Microfinance Platform (authoritative execution plan)

Backend: Supabase `xwxqunklduknceoryrha`, connected. No connection work remains.

## Locked decisions (do not re-litigate)

Reused from the inherited codebase: document generation engine · auth / PIN /
invitation engine · navigation, app shell and UI system · report engine ·
company/institution settings · audit logging · storage · finance core (Chart of
Accounts, journals, GL, fiscal periods, fixed assets, banking + reconciliation,
payment settlement engine — all retargeted to lending, not sales).

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, multi-tenancy, client portal.

Architecture invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group. Never batch multi-object SQL.

## Verified state (read from the codebase, 2026-09-04)

Verified complete:
- Apps: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages remain under `src/pages`.
- Lending domain live end-to-end: clients, groups, loan products, applications,
  assessment/approval, loans, disbursement, schedule engine, repayments
  (ASA group sheet **and** single-client payment), collections, arrears/PAR,
  top-up / restructure / write-off / closure as distinct events, penalties with
  policy-ordered allocation, officer data scope, reversal & duplicate guards.
- Report catalogue is microfinance-only: 24 registry entries across
  `lending, statutory, cash_bank, audit, management, fixed_assets`. FX
  (revaluation / exposure / realized), aged receivables and aged payables are
  gone from the registry, nav, search and routes. Nine lending reports routed.
- Finance ERP surfaces removed: `receivables` / `payables` routes and pages,
  customer-invoice / vendor-bill dashboard cards, ERP command-palette actions.
- Studio entity catalogue is microfinance-only (`mf_*`, `employee`, `expense`).

Fixed this session (was blocking the build):
- `StudioFields.tsx`, `FormLayoutDesigner.tsx`, `SavedViewsManager.tsx` still
  carried the ERP entity list (contact / invoice / sales_order / bill / product).
  Icon maps, entity groups and defaults now come from
  `src/lib/studio/entities.ts`. Typecheck clean, build OK.

Known residue, deliberately left inert (removing it costs more than it returns):
delivery notes, sales orders, recurring invoices, sales returns and eTIMS
identifiers remain in the shared document/outbox/audit/studio metadata. No
navigation, no hooks, no UI reaches them.

## Remaining milestones, one at a time

### N1 — Owner verification pass (next, blocks nothing else)
Sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and
PAR render; one report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine. Any failure
found here is fixed before N2.

### N2 — Dead ERP table groups (DB slimming)
One migration per group, FK-ordered: inventory/WMS → purchasing →
sales/POS/CRM → projects → marketplace. Keep auth, org/branch, finance core,
banking, documents, reporting, audit, `mf_*`. Verify counts after each.

### N3 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches by group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### N4 — Linter posture on what remains
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection — retained schema only.

### N5 — Domain depth (only if the owner asks)
Savings, regulatory returns, cash-management/teller sessions. Not in scope until
requested.

## Working rules
- No second implementation where a mature engine exists.
- No frontend-authoritative financial math.
- Do not audit, document or polish anything outside microfinance scope.
- Update this file after each milestone; keep it short and factual.
