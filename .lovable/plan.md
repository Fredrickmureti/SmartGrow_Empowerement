# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-03 (sixth pass, verified against the live database and codebase).
One institution, employee-operated microfinance platform on the ASA branch model:
branch → loan officer → group → client, individual obligors, staff-only, no
client portal.

Backend: Supabase `xwxqunklduknceoryrha` is connected via `.env` and
`supabase/config.toml`. Connection work is DONE — never redo it.

## Locked decisions — do not re-litigate

REUSE as infrastructure, retargeted to microfinance data and wording: auth +
PIN + invitation, document generation engine, navigation / app shell / UI
system, Chart of Accounts + journals + GL + fiscal periods, banking + bank
reconciliation, payment settlement & allocation engine, receivables/payables
engines (loan receivables, institution payables), statements engine (client /
loan statements), fixed assets, company & general settings, audit logging,
reporting engine, storage/files. SMS infrastructure is kept — collections
reminders will use it.

OUT permanently: sales, purchases, POS, inventory/products, warehouse, CRM,
projects, HR, payroll, recruitment, attendance, timesheets, localization/tax
packs, marketplace / entitlements / plan limits, multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; migrations stay small and single-purpose;
never build microfinance surfaces over legacy ERP rows.

## Verified state (2026-09-03)

- Build OK, typecheck clean.
- Apps: `dashboard, finance, lending, platform, reports, studio`.
  `src/apps/lending` covers clients, groups, products, applications, loans,
  repayments, collections, reports, documents, settings.
- Database: 19 `mf_*` tables live, all with RLS + policies.
  `mf_post_event → mf_resolve_account → post_journal_entry_atomic` is the
  financial authority; balances, arrears, PAR, installment status and statements
  are views.
- Permissions: `user_has_module_permission` grants module `lending` from the
  base role, mirroring `LENDING_ROLE_PERMISSIONS`. Owner
  `fredrickmureti612@gmail.com` = `owner`, active.
- Schema slimming is well advanced: 398 public tables (was 842). POS,
  products/inventory, warehouse, purchasing and payroll tables are ALREADY
  gone — do not plan drops for them again.
- The earlier over-broad orphan-function purge has been repaired (70 platform
  functions restored). **No further blind/regex-driven function drops.** Four
  functions were intentionally left out because they depend on removed ERP
  objects: `assert_manager_override`, `bank_feed_status`, `is_orphan_identity`,
  `start_app_trial`.
- Payroll code residue removed: the `payroll_runs` branch of
  `TransactionPreviewDrawer` and the POS branch of `useDashboardAnalytics`
  are deleted. Remaining `payroll_*` / `pos_*` strings in
  `src/pages/audit-logs/format.ts` and `OrgDataResetTool.tsx` are inert label
  maps — leave them.
- Localization/tax-pack subsystem dropped (24 `pack_*` /
  `localization_pack_*` tables + `v_org_active_localization_pack`), zero code
  references.

## M3 — Remaining ERP strip (active milestone)

Order matters: strip the CODE that reads a table group, then drop the group in
its own migration.

1. Dead schema with zero code references — one migration per group:
   - retail/fiscal residue: `controlled_substance_register`, `delivery_proofs`,
     `fiscal_device_credentials`, `sales_document_idempotency`,
     `customer_loyalty` + `loyalty_transactions`, `carrier_services`,
     `physical_count_*`, `etims_*`.
   - `customer_groups` needs the `contacts` FK dropped first.
2. Code-then-schema groups (still referenced by `src/`, counts = files):
   delivery notes (17), recurring invoices (13), sales orders (7),
   customer credit (7), sales returns (4), backorders (4), carriers (2).
   Delete the surfaces and services, then drop the tables.
3. `invoices` / `bills` / `estimates` / `credit_notes` stay for now — the
   receivables/payables + settlement engines are retained infrastructure.
   Retarget them to loan receivables and institution payables; do not delete.
4. Linter posture LAST, once the schema stops shrinking: 2,025 findings, all
   inherited AccrualFlow surface (mostly SECURITY DEFINER EXECUTE grants,
   11 SECURITY DEFINER views, 47 mutable search_path functions, leaked-password
   protection off). Do not chase these mid-strip.

## M4+ — Microfinance domain depth (one milestone each)

Top-ups and restructuring as distinct business events (never `UPDATE loans`);
write-off approval + accounting treatment; collections field workflow (visits,
promises to pay, outcomes); remaining reports — officer collections, branch
collections, product performance, client exposure, PAR aging.

## Owner verification (open, owner-side, preview only)

Authenticated end-to-end checks cannot run from the sandbox (external Supabase,
no mintable session). Sign in as owner and confirm: `/lending` and children
open; dashboard KPIs load and PAR shows a ratio; Governance → Segregation of
Duties shows lending pairs; one report, one client statement, one repayment
receipt and one disbursement confirmation render through the document engine;
a banked collection matches in bank reconciliation.

## Working rules

- Update this file after every milestone; keep it factual and short.
- One migration = one purpose. Never batch multi-object SQL.
