# Smart Grow Empowerment — Microfinance Platform, Plan of Record

Reworked 2026-09-03 (fourth pass, independently verified against code + live
database). One institution, employee-operated microfinance platform (branch /
loan officer / group model, individual lending fully supported). Supabase
project `xwxqunklduknceoryrha` ("Smart Grow Empowerment") is connected via
`.env` and `supabase/config.toml` — no connection work remains.

## Locked decisions — do not re-litigate

REUSE as infrastructure (retarget wording/data only): auth + PIN + invitation,
document generation engine, navigation / app shell / UI system, Chart of
Accounts + journals + GL + fiscal periods, banking + bank reconciliation,
payment settlement + allocation engine, fixed assets, company & general
settings, audit logging, reporting engine, storage/files.

OUT permanently: sales, purchases, POS, inventory/products, warehouse, CRM,
projects, HR, payroll, recruitment, attendance, timesheets, marketplace /
entitlements / plan limits, multi-tenancy, client portal.

Rules: no second implementation where a mature engine exists; no
frontend-authoritative financial math; individual and group repayment share
one code path and one allocation policy; no standalone audit reports; no
"upgrade plan" / SaaS gating anywhere.

## Verified state (2026-09-03, fourth pass)

Frontend (verified by reading code + typecheck + build OK):
- Apps: dashboard, finance, lending, platform, reports, studio. `src/pages`
  holds no ERP sales/purchase/inventory/HR/payroll surface.
- Lending access fix is real: `usePermissions` resolves only through
  `resolveEffectivePermissions`; session role union includes
  `branch_manager`, `loan_officer`, `credit_officer`, `collections_officer`,
  `auditor`.
- Settings: Company hub = company & branches, currency, payments, pay methods,
  email, templates, printing. Workspace hub = profile, appearance, workspace,
  notifications (lending categories), security, access groups, governance,
  data. `Settings.tsx` alias map matches (dead ERP aliases removed).
- Orphaned `NotificationThresholdSettings` removed.
- Branding: login, root metadata, `index.html`, AI assistant, theme settings
  now say Smart Grow Empowerment. Login page renders; title confirmed; no
  hydration-mismatch error logged on `/`, `/login`, `/lending` (unauthenticated).
- `CreateBranchDialog` no longer calls a SaaS plan-limit check or routes to
  `/upgrade` (route does not exist).

Database (verified by query):
- 25 `mf_*` objects live; `mf_post_event → mf_resolve_account →
  post_journal_entry_atomic` is the financial authority; balances, arrears,
  PAR (ratios coalesced to 0), installment status, statements are views.
- Segregation of Duties retargeted: 12 conflict pairs remain (loan
  request/originate/approve/disburse/write-off, payment create/approve/execute,
  bank modify vs payment execute, JE post vs reverse, role grant vs user
  deactivate). `loan.*` duties now map to `lending` module permissions
  (previously mapped to payroll employee-loan permissions). ERP duty pairs
  (PO, GRN, bills, sourcing, payroll, compensation, leave, inventory, vendor,
  requisition, contract) deleted.
- `user_has_module_permission` now honours `can_pay`, `can_close`,
  `can_reverse` group flags (they existed but were ignored).
- `user_roles`: `fredrickmureti612@gmail.com` = `owner`, active.

## Known gaps (factual)

1. Lending roles (`loan_officer`, `credit_officer`, …) get lending access in
   the UI matrix but the DB `user_has_module_permission` base-role branch
   grants them nothing — they only get DB-side module permission through
   Access Groups. Decide in M2 whether to seed one access group per lending
   role (preferred: data, no code) or extend the base-role CASE.
2. The database still carries the full ERP schema (~800 tables, ~2,900
   functions) inherited from AccrualFlow migrations. Nothing in the app
   reaches the ERP tables, but they inflate the linter (3,672 pre-existing
   findings: SECURITY DEFINER views, anon-executable functions, mutable
   search_path). Dropping them is dependency-sensitive (shared triggers,
   RLS helpers) and is scheduled as M3, after lending is production-verified.
3. Authenticated end-to-end checks cannot be run from the sandbox (external
   Supabase, no mintable session). The owner must perform the M1 verification
   pass in the preview.

## M1 — Close-out (owner verification in the running app) — NEXT

Sign in as owner and confirm, fixing code where anything fails:
1. `/lending` and every child route open (clients, groups, products,
   applications, loans, repayments, collections, reports, mappings).
2. Dashboard KPIs load; PAR shows a ratio, not NULL/blank.
3. Settings → Governance → Segregation of Duties renders the lending pairs.
4. One report render, one client statement, one repayment receipt, one
   disbursement confirmation through the shared document engine.
5. Bank-reconciliation match of a banked collection.

Exit: all five observed; discrepancies fixed in code, not written up.

## M2 — Permissions data + dead-code strip

- Seed access groups for lending roles (gap 1) so DB-side checks agree with
  the UI matrix; verify a `loan_officer` sees only own-portfolio clients.
- Remove `useDashboardStats`, `useDashboardAnalytics` (ERP revenue/expense
  math), `useEntityCreationLimits` and remaining entitlement/module gating
  after an import-graph check; prune `src/parked-modules.d.ts` stubs.
- Typecheck, build, RLS pass on `mf_*` tables and views only.

## M3 — Database slimming and hardening (after M1+M2 verified)

- Dependency-checked drop of ERP-only schema groups (inventory, purchasing,
  sales/POS, HR/payroll, CRM, projects, marketplace) in small, reviewed
  migrations; keep auth, org/branch, finance core, banking, documents,
  reporting, audit, `mf_*`.
- Then address the linter posture on what remains (SECURITY DEFINER views,
  function search_path, anon EXECUTE revokes, leaked-password protection).

## Then: microfinance domain depth (each its own milestone)

Top-ups & restructuring as distinct events; write-off approval + accounting
treatment; collections field workflow (visits, promises, outcomes); remaining
report set (officer/branch collections, product performance, client exposure).


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================

M1 code work is complete and verified (typecheck + build OK): permissions fix confirmed real, ERP settings aliases and orphaned component removed, Smart Grow Empowerment branding applied, SaaS branch-limit gate removed, and Segregation of Duties now checks lending duties (loan request/approve/disburse/write-off) instead of payroll ones. The plan is rewritten with the verified state, two factual gaps (lending roles have no DB-side access groups yet; the database still carries the full ERP schema, scheduled for a dependency-checked drop in M3), and the exact next step.

what is remaining sign in as owner in the preview and run the five M1 close-out checks listed in the plan (Lending routes, dashboard KPIs, SoD page, one document render, one bank-reconciliation match) — I can't mint a session against your external Supabase from here. Tell me anything that fails and I'll fix it, then proceed to M2.

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
