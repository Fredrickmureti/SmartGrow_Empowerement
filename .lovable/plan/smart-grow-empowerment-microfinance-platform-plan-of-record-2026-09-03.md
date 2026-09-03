# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-03 (third pass). One institution, employee-operated
microfinance platform (ASA-style branch / loan officer / group model, individual
lending fully supported), built on the existing platform engines. Supabase
project `xwxqunklduknceoryrha` is already connected — no connection work.

## Locked decisions — do not re-litigate

REUSE as infrastructure, retarget wording/data only: auth + PIN + invitation,
document generation engine, navigation / app shell / UI system, Chart of
Accounts + journals + GL + fiscal periods, banking + bank reconciliation,
payment settlement + allocation engine, fixed assets, company & general
settings, audit logging, reporting engine, storage/files.

OUT permanently: sales, purchases, POS, inventory/products, warehouse, CRM,
projects, HR, payroll, recruitment, attendance, timesheets, marketplace /
entitlements, multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math (balances, interest, arrears, allocations
come from the database); individual and group repayment share one code path and
one allocation policy; no standalone audit reports.

## Verified state (code + live database, 2026-09-03)

- Apps: dashboard, finance, lending, platform, reports, studio. No ERP
  sales/purchase/inventory/HR/payroll surface remains in `src/pages`.
- 25 `mf_*` objects live. Financial authority is server-side
  (`mf_post_event` → `mf_resolve_account` → `post_journal_entry_atomic`);
  balances, arrears, PAR, installment status, client statement are views.
- Lending frontend complete: clients, groups, products + versions,
  applications, loans, repayments (individual + group batch), collections,
  5 reports, accounting mappings, documents through the shared engine.
- Both legs now exercised live: individual lifecycle, and group lifecycle
  (GRP-001, 3 members → applications → approvals → disbursements →
  group-meeting batch BATCH-001 → cash/mobile-money banking, journal balanced).
- `user_roles` has one row: `fredrickmureti612@gmail.com` = `owner`, active.

## Confirmed defects (root-caused, not guessed)

1. **Lending "access denied" for the owner/admin — root cause found.**
   `resolveEffectivePermissions()` in `src/lib/permissions.ts` grants lending
   permissions (and full access to owner/admin/super_admin), but
   `src/hooks/usePermissions.ts` only calls it **when access-group rules
   exist**; otherwise it falls back to `ROLE_PERMISSIONS[role]`, which
   deliberately excludes the lending matrix. The owner has no group rules, so
   `can("viewClients")` is false and every `PermissionProtectedRoute` in
   `src/apps/lending/routes.tsx` redirects to `/dashboard`.
2. `mf_par_summary` returns NULL for `par_1/30/90` when nothing is overdue and
   exposes amounts without the ratio the KPI label claims.
3. Loan `LN-000001` is `status='closed'` with 44,920 outstanding — a legacy
   artifact from the first lifecycle test (`mf_close_loan` itself guards
   correctly).
4. Settings still carry ERP tabs: Company hub has `tax`, `tax-compliance`,
   `payment-terms`, `receipts`, `inventory`; Workspace hub `notifications` is
   ERP-era. `Settings.tsx` redirect map still routes removed ERP tabs.
   Governance → SoD is generic (`governance_sod_violations` contains no payroll
   logic) — keep it, retarget its duty pairs to lending duties.
5. Login page / root metadata still show AccrualFlow branding; a shell
   hydration mismatch is logged on load.

## M1 — Unblock the app and correct the defects (NEXT)

1. `usePermissions` always resolves through `resolveEffectivePermissions(role,
   groupRules)` (no `ROLE_PERMISSIONS` fallback), so owner/admin/super_admin get
   full access and lending roles get their matrix. Add the lending roles
   (`branch_manager`, `loan_officer`, `credit_officer`, `collections_officer`,
   `auditor`) to the session role union so they type-resolve. Verify in the
   running app that `/lending` and every child route open as owner.
2. Fix `mf_par_summary` (migration): coalesce to 0 and return both arrears
   amount and PAR ratio; align the dashboard KPI label to what it returns.
3. Correct the `LN-000001` artifact row so status matches its balance.
4. Settings scrub (presentation + routing only):
   - Company hub keeps: company identity/branding, currency, payment methods,
     email, document templates. Remove `tax`, `tax-compliance`, `payment-terms`,
     `receipts`, `inventory` tabs and their route aliases.
   - Workspace hub keeps: profile, appearance, workspace, security, access
     groups, governance (SoD), data. Retarget or drop `notifications` depending
     on whether any live event feeds it.
   - `Settings.tsx` alias map trimmed to surviving tabs; removed aliases fall
     back to the hub root instead of a dead tab.
5. Branding: replace AccrualFlow strings on the login page and root metadata
   with Smart Grow Empowerment; fix the hydration mismatch.
6. Remaining verification against existing data: bank-reconciliation match of
   the banked collection, dashboard KPIs, one report render, one client
   statement, one repayment receipt, one disbursement confirmation.

Exit: every step observed working in the running app; discrepancies fixed in
code, not written up.

## M2 — Dead-code strip and hardening (LAST)

- Remove `useDashboardStats`, `useDashboardAnalytics` (ERP revenue/expense math)
  and the module/entitlement gating they carry, after an import-graph check.
- Prune `src/parked-modules.d.ts` stubs no retained file needs.
- Close out: typecheck, build, permission/RLS pass (the inherited Supabase
  linter posture — 1 table without RLS, SECURITY DEFINER views — is hardened
  here).
