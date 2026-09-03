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

1. The database still carries the inherited AccrualFlow ERP schema (~800
   tables, ~2,900 functions). Unused by the app, but it inflates the linter and
   the surface area. Dropping is dependency-sensitive → M3.
2. Authenticated end-to-end checks cannot be run from the sandbox (external
   Supabase, no mintable session) — owner verifies in the preview.

## M1 — Owner verification pass (open, owner-side)

Sign in as owner in the preview and confirm; anything that fails gets fixed in
code, not written up:
1. `/lending` and every child route open.
2. Dashboard KPIs load; PAR shows a ratio, not blank.
3. Settings → Governance → Segregation of Duties shows lending pairs.
4. One report, one client statement, one repayment receipt and one disbursement
   confirmation render through the shared document engine.
5. Bank-reconciliation match of a banked collection.

## M2 — Permissions parity + dead-code strip — DONE (2026-09-03)

- `user_has_module_permission` now grants module `lending` straight from the
  base role, mirroring `LENDING_ROLE_PERMISSIONS` in `src/lib/permissions.ts`:
  read/export for all five lending roles; create for branch_manager,
  credit_officer, loan_officer; write adds collections_officer; approve for
  branch_manager + credit_officer; pay (disburse/receipt) for branch_manager,
  loan_officer, collections_officer; close for branch_manager. Lending roles
  also get `settings:read`. Chosen over per-org seed data: deterministic, no
  data drift, one source of truth. Access Groups still layer on top.
- `useEntityCreationLimits` deleted (zero references). `useDashboardStats` /
  `useDashboardComposition` KEPT — they feed the live Finance dashboard, and the
  cheap fix is retargeting their figures in M4, not deleting them.
- RLS verified: all 19 `mf_*` tables have RLS enabled with policies.
- Typecheck clean. Linter count unchanged at 3,672 (all pre-existing ERP
  inheritance, addressed in M3).

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


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================



The talent/recruitment/training schema drop succeeded, but it cascaded away the `v_employees_canonical` view (it referenced `job_positions`), which two live hooks depend on — `useCurrentEmployee.ts` and `governance/useGovernedEntityOptions.ts`. That's a build break I need to fix next by recreating the view without the dropped position columns (or repointing those hooks at `employees` directly).

Want me to continue with that fix and the rest of M3?

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
