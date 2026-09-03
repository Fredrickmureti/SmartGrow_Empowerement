# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-03 (fifth pass). One institution, employee-operated
microfinance platform on the ASA branch model: branch → loan officer → group →
client, individual obligors, staff-only operations, no client portal.

Backend: Supabase project `xwxqunklduknceoryrha` ("Smart Grow Empowerment") is
already connected through `.env` and `supabase/config.toml`. No connection work
remains — do not re-do it.

## Locked decisions — do not re-litigate

REUSE as infrastructure, retargeted to microfinance wording and data:
auth + PIN + invitation, document generation engine, navigation / app shell /
UI system, Chart of Accounts + journals + GL + fiscal periods, banking + bank
reconciliation, payment settlement & allocation engine, receivables/payables
engines (retargeted: loan receivables, institution payables), statements engine
(client/loan statements, not customer sales statements), fixed assets, company
& general settings, audit logging, reporting engine, storage/files.

OUT permanently: sales, purchases, POS, inventory/products, warehouse, CRM,
projects, HR, payroll, recruitment, attendance, timesheets, marketplace /
entitlements / plan limits, multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; no standalone audit reports; no SaaS
gating anywhere.

## Verified state (2026-09-03)

- Apps present: `dashboard, finance, lending, platform, reports, studio`.
  `src/apps/lending` covers clients, groups, products, applications, loans,
  repayments, collections, reports, documents, settings. No ERP
  sales/purchase/inventory/HR/payroll surface remains under `src/pages`.
- Permissions: `usePermissions` resolves only via `resolveEffectivePermissions`;
  session role union includes branch_manager, loan_officer, credit_officer,
  collections_officer, auditor.
- Settings hubs retargeted (Company + Workspace); dead ERP aliases removed;
  SaaS branch-limit gate and `/upgrade` routing removed; branding is Smart Grow
  Empowerment across login, root metadata, `index.html`, AI assistant.
- Database: 25 `mf_*` objects live. `mf_post_event → mf_resolve_account →
  post_journal_entry_atomic` is the financial authority; balances, arrears, PAR,
  installment status and statements are views. Segregation of Duties retargeted
  to lending duties; ERP duty pairs deleted. `user_has_module_permission`
  honours `can_pay` / `can_close` / `can_reverse`.
- Owner user `fredrickmureti612@gmail.com` = `owner`, active.

## Open gaps (factual)

1. Lending roles get UI access but no DB-side module permission from the
   base-role branch of `user_has_module_permission` — only via Access Groups.
2. The database still carries the inherited AccrualFlow ERP schema (~800
   tables, ~2,900 functions). Unused by the app, but it inflates the linter and
   the surface area. Dropping is dependency-sensitive.
3. Dead ERP hooks still present: `useDashboardStats`, `useDashboardComposition`,
   `useEntityCreationLimits` (+ `src/parked-modules.d.ts` stubs).
4. Authenticated end-to-end checks cannot be run from the sandbox (external
   Supabase, no mintable session) — owner verifies in the preview.

## M1 — Owner verification pass (NEXT, no code until it reports)

Sign in as owner in the preview and confirm; anything that fails gets fixed in
code, not written up:
1. `/lending` and every child route open.
2. Dashboard KPIs load; PAR shows a ratio, not blank.
3. Settings → Governance → Segregation of Duties shows lending pairs.
4. One report, one client statement, one repayment receipt and one disbursement
   confirmation render through the shared document engine.
5. Bank-reconciliation match of a banked collection.

## M2 — Permissions data + dead-code strip

- Seed one access group per lending role so DB checks agree with the UI matrix;
  verify a loan_officer sees only own-portfolio clients.
- Delete gap-3 hooks after an import-graph check; prune parked-module stubs.
- Typecheck + build; RLS pass over `mf_*` tables and views.

## M3 — Database slimming and hardening

Dependency-checked drops of ERP-only schema groups (inventory, purchasing,
sales/POS, HR/payroll, CRM, projects, marketplace) in small single-purpose
migrations. Keep auth, org/branch, finance core, banking, documents, reporting,
audit, `mf_*`. Then fix the linter posture on what remains (SECURITY DEFINER
views, function search_path, anon EXECUTE revokes, leaked-password protection).

## M4+ — Microfinance domain depth (one milestone each)

Top-ups and restructuring as distinct business events (never `UPDATE loans`);
write-off approval + accounting treatment; collections field workflow (visits,
promises to pay, outcomes); remaining reports — officer collections, branch
collections, product performance, client exposure, PAR aging.

## Working rules for the next engineer

- Update this file after every milestone; keep it factual and short.
- Migrations stay small and single-purpose — never batch multi-object SQL.
- Never build microfinance surfaces over legacy ERP rows; only `mf_*` and the
  retained platform tables are institution data.
