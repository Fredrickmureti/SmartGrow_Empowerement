# Smart Grow Empowerment — Microfinance Platform (execution plan)

Backend: Supabase `xwxqunklduknceoryrha`, already connected. No connection work remains.

## Verified now (read from the codebase, not from the old log)

- Apps shipped: `dashboard, finance, lending, platform, reports, studio`. No ERP
  sales/purchases/POS/inventory/HR pages remain under `src/pages`.
- Lending app is real: clients, groups, products, applications, loans, repayments,
  collections, documents, settings, plus **9 lending report pages** on the shared
  report engine (`src/apps/lending/reports/*`).
- Report registry is already microfinance-shaped: categories are
  `lending, statutory, cash_bank, audit, management, fixed_assets` — no FX or
  inventory category remains, and the 9 lending reports are registered.
- **Orphans confirmed**: `/finance/reports/fx-revaluation`, `fx-exposure`,
  `fx-realized` are still routed in `src/apps/finance/routes.tsx` with three
  page files, but are in no registry, no nav — dead ERP surface reachable by URL.
  `/finance/reports/aging` (ERP receivables aging) is likewise routed but
  unregistered, and duplicates the lending PAR-aging report.
- Financial authority is server-side (`mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`); balances/arrears/PAR are views. Correct pattern.
- Database is still heavy: ~398 tables and ~2,800 functions, most belonging to
  the dead ERP groups (inventory/WMS, purchasing, sales/POS/CRM, projects,
  marketplace) and ~1,400 functions referencing relations that no longer exist.

## What is reused (locked, do not re-litigate)

Document generation engine · auth/PIN/invitation engine · navigation, app shell
and UI system · Chart of Accounts + journals + GL + fiscal periods · report
engine · company/institution settings · audit logging · storage.

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, multi-tenancy, client portal.

## Milestones, in order — one at a time, verify before the next

### M1 — Report and route cleanup (small, do first)
- Delete the FX report routes and the three FX page files; delete the ERP
  `reports/aging` route and page (PAR aging is the microfinance equivalent).
- Sweep `src/apps/finance/routes.tsx` and `FINANCE_NAV` for any other route not
  present in `REPORT_REGISTRY`, and remove it.
- Rename the residual ERP framing in Finance nav where it is only ERP wording
  ("Loan receivables" / "Institution payables" stay only if they are backed by
  microfinance data; otherwise the entries go).
- Exit: typecheck clean, every remaining `/finance/reports/*` and
  `/lending/reports/*` route is a registry entry.

### M2 — Dead ERP table groups
One migration per group, FK-checked, in this order: inventory/WMS → purchasing →
sales/POS/CRM → projects → marketplace. Keep auth, org/branch, finance core,
banking, documents, reporting, audit, `mf_*`.

### M3 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches by group. Never touch `mf_*`. Confirm no trigger on a
live table depends on a function before dropping it.

### M4 — Linter posture on what remains
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection — only for retained schema.

### M5 — Microfinance domain depth (one milestone each)
1. Top-ups and restructuring as distinct business events (never `UPDATE loans`).
2. Write-off: approval control + accounting treatment.
3. Collections field workflow: visits, promises to pay, outcomes.
4. Retarget the Finance dashboard figures to portfolio metrics.

## Owner verification (parallel, preview only)
Sandbox cannot mint a session against the external Supabase project, so the
owner confirms in the preview: `/lending` and children open; dashboard KPIs and
PAR render; one report, one client statement, one repayment receipt and one
disbursement confirmation render through the shared document engine.

## Working rules
- One migration = one object group. Never batch multi-object SQL.
- No second implementation where a mature engine exists.
- No frontend-authoritative financial math.
- Do not audit, document or polish anything outside microfinance scope.
- Update this file after each milestone; keep it short and factual.
