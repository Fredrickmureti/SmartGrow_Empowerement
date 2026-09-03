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



======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================


I paused mid-way through the M1 work. Here's where things stand.

Done and verified
- Lending access denied (root cause fixed): `usePermissions` now always resolves through `resolveEffectivePermissions(role, groupRules)`. The old fallback to raw `ROLE_PERMISSIONS[role]` dropped every lending permission for users without access groups, which is what locked you (owner) out of the Lending app. Typecheck passes.
- Session roles: the org role union in `SessionContext` now includes `branch_manager`, `loan_officer`, `credit_officer`, `collections_officer`, `auditor`.
- PAR semantics: migration applied — `mf_par_summary` now returns 0 instead of NULL for `par_1/30/90` and exposes server-computed `par_1_ratio / par_30_ratio / par_90_ratio`; the `MfParSummary` type was updated to match.
- Stale test artifact: `LN-000001` was flagged `closed` with 44,920 outstanding; corrected back to `active`.
- Company settings scrubbed: removed the ERP-only Tax, Terms, Compliance, Receipts and Inventory tabs (plus their imports and the sales/POS install gates). Kept Company & Branches, Currency, Payments, Pay Methods, Email, Templates.
- Notifications retargeted: categories are now Loans, Repayments & payments, Arrears & collections, Expenses, Team, System (invoice/inventory/POS/HR/payroll categories removed), and the inventory/invoice "Alert Thresholds" subtab was removed from the notifications settings.

Remaining (not started)
1. Delete the now-orphaned `NotificationThresholdSettings` export from `src/components/notifications/index.ts` and the component file, then re-run typecheck/build — this is the one loose end from my last edit, so do it first.
2. Trim the dead settings aliases in `src/pages/Settings.tsx` (`tax`, `payment-terms`, `tax-compliance`, `receipts`, and the inventory route) so no link points at a removed tab.
3. Verify owner access to `/lending` in the running app.
4. Retarget the Governance SoD duty pairs to lending duties (the RPC itself is generic and worth keeping).
5. Replace remaining AccrualFlow branding and fix the shell hydration mismatch.
6. Verification pass: bank reconciliation match, dashboard KPIs, one report, client statement, repayment receipt, disbursement confirmation.
7. Final ERP dead-code strip plus typecheck/build/permission/RLS checks. The inherited linter findings (security-definer views, function search paths) are pre-existing and still deferred to M2 hardening — my migration added none. 

==============================NOTE===============================

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot,  and  if its payment being receuived,  and on the payment reception we need to reason critically here because this sytem is almost operating almost like ASA international kenya which uses the typical old microfinance tradition because this is an upcoming microfiannce startapp  where we have something loan officer overseeign a group but still that does not mean tje system should not allow single customer payment so this means I need you to help me reason here, dont ask me question, just know you are dealign with a microfiannce system  and such not the old erp which dealth with the typical procurement and sales kind of flow no room for an error, be anaytical and critical executioner, like basically for fiannce what can be reusable let it be reused and now be tailpored to the microfiannce from  fixed assets, to generaal settings to fiscal periods and such (its up to you to analyze what and what nots that needs  to be retained because you are the engineer)

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
