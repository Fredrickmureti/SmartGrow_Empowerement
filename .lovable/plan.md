# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-04 (sixth pass, new engineer handover). One institution,
employee-operated microfinance platform on the ASA branch model: branch → loan
officer → group → client, individual obligors, staff-only operations, no client
portal.

Backend: Supabase `xwxqunklduknceoryrha` is connected via `.env` and
`supabase/config.toml`. No connection work remains.

## Locked decisions — do not re-litigate

Reused as infrastructure (retargeted wording/data only): auth + PIN +
invitation, document generation engine, navigation / app shell / UI system,
Chart of Accounts + journals + GL + fiscal periods, banking + reconciliation,
payment settlement & allocation engine, statements engine, fixed assets,
company & general settings, audit logging, reporting engine, storage/files.

Out permanently: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace/entitlements, multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share one
code path and one allocation policy; migrations stay small and single-purpose;
never build microfinance surfaces over legacy ERP rows.

## Verified state (checked against code + live DB, 2026-09-04)

- Apps: `dashboard, finance, lending, platform, reports, studio`. Lending
  covers clients, groups, products, applications, loans, repayments,
  collections, reports, documents, settings. No ERP sales/purchase/inventory/
  HR surface remains in `src/pages`.
- `usePermissions` resolves solely through `resolveEffectivePermissions`;
  lending roles are in the session role union;
  `user_has_module_permission` grants module `lending` from the base role.
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears, PAR, installment status and
  statements are views. 19 `mf_*` tables, all with RLS + policies.
- Branding is Smart Grow Empowerment across login, root metadata, `index.html`.
- Database slimming underway: **398 tables** (from ~842), 53 views, **2,814
  functions**. Entire HR/payroll group dropped (0 payroll/payslip tables left);
  inventory/purchasing/sales/POS/CRM groups still present as dead schema.
- Typecheck clean. 167 test files pass; 12 pre-existing failures are scanners
  over the inherited SQL history — out of scope, do not spend credits there.

## Open gaps

1. ~1,400 of the remaining PL/pgSQL functions reference relations that no
   longer exist; they drive most of the linter noise.
2. Dead ERP table groups (inventory/wms, purchasing, sales/pos/crm, projects,
   marketplace) still occupy the schema.
3. Authenticated end-to-end checks cannot run from the sandbox (external
   Supabase, no mintable session) — owner verifies in the preview.

## M3 — Database slimming and hardening (NEXT, in this order)

1. **Orphan function purge.** Drop PL/pgSQL functions whose referenced
   relations no longer exist, in dependency-checked batches by schema group.
   Exclude every `mf_*` function; before each batch confirm no trigger on a
   live table depends on it.
2. **Dead ERP table groups.** Drop inventory/wms, purchasing, sales/POS/CRM,
   projects and marketplace tables — one group per migration, FK-checked.
   Keep auth, org/branch, finance core, banking, documents, reporting, audit,
   `mf_*`.
3. **Linter posture on what remains.** SECURITY DEFINER views, function
   `search_path`, anon EXECUTE revokes, leaked-password protection.

Exit: linter noise reduced to findings that belong to retained schema; app
still builds, typechecks and loads every lending route.

## M4 — Owner verification pass (owner-side, can run in parallel)

Sign in as owner in the preview and confirm; failures get fixed in code, not
written up:
1. `/lending` and every child route open.
2. Dashboard KPIs load; PAR shows a ratio, not blank.
3. Settings → Governance → Segregation of Duties shows lending duty pairs.
4. One report, one client statement, one repayment receipt and one
   disbursement confirmation render through the shared document engine.
5. Bank-reconciliation match of a banked collection.

## M5+ — Microfinance domain depth (one milestone each)

1. Top-ups and restructuring as distinct business events (never `UPDATE loans`).
2. Write-off: approval control + accounting treatment.
3. Collections field workflow: visits, promises to pay, outcomes.
4. Remaining reports: officer collections, branch collections, product
   performance, client exposure, PAR aging.
5. Retarget the Finance dashboard figures (`useDashboardStats` /
   `useDashboardComposition`) to portfolio metrics.

## Working rules for the next engineer

- Update this file after every milestone; keep it factual and short.
- One migration = one object group. Never batch multi-object SQL.
- Do not audit, document or polish anything outside the microfinance scope.
