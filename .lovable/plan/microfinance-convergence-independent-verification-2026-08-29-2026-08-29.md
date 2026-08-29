# Microfinance Convergence — Independent Verification (2026-08-29) and Reworked Plan

## Phase 1 — What I verified myself, directly

I re-checked every claim in the previous plan and in the previous engineer's final message against the codebase, the running dev server and the connected database. Verified findings only:

| Claim | Verified reality |
| --- | --- |
| M0 stack repair — "app boots" | **FALSE.** `http://localhost:8080` still returns **500**. The old `#tanstack-start-entry` error is gone (`vite.config.ts` now uses the TanStack wrapper, `src/server.ts` is the v1 entry shape), but a new hard failure replaced it: `Missing "#tanstack-start-plugin-adapters" specifier in "@tanstack/start-server-core"`. Cause is a version split in the installed TanStack packages: `start-server-core 1.167.19` vs `start-plugin-core 1.168.0` vs `react-start 1.167.43` vs `router 1.169.1`. Nothing in the app can be verified while SSR 500s. |
| M1 project pinning | **DONE.** `supabase/config.toml` reads `project_id = "xwxqunklduknceoryrha"` (the connected project), not the AccrualFlow ref. |
| M2 dangling-import purge | **NOT DONE.** 30 retained files still import deleted ERP modules (`src/services/reports/reportsNav.ts` plus 29 architecture/AI tests referencing sales/purchases/inventory/pos/warehouse/crm). `electron/`, `packages/`, `agent/` are all still present. |
| M3 RBAC + PIN | **PARTIALLY DONE, as the previous engineer's last message admits.** `permission_groups`, `permission_group_rules`, `member_permission_groups`, `user_security_preferences` exist; `user_pins` policies and the PIN lifecycle functions (`set_user_pin`, `verify_user_pin`, `verify_pin_unauthenticated`, `disable_user_pin`), `get_user_session_data`, `set_last_org_id`, `bootstrap_super_admin`, `is_org_admin_or_owner`, `user_has_module_permission` are all present in the live DB. **Still broken:** `has_user_pin()` and `check_pin_status()` do not exist, yet `src/hooks/security/usePINLogin.ts`, `src/components/auth/EnhancedLoginForm.tsx` and `src/pages/admin/AdminLogin.tsx` call them — PIN login cannot complete. Super-admin seeding never happened (no auth users yet). |
| M6 microfinance workspace | **NOT STARTED.** `src/apps/` contains contacts, dashboard, finance, hr, me, platform, platform-admin, reports, studio — no `microfinance`. |

Problems the previous plan never recorded:

- **Payroll is still in the app**, in direct conflict with the parent brief's "NO PAYROLL": `src/apps/hr/sub/PayrollRoutes.tsx` plus payroll references in `src/apps/hr/{index.ts,routes.tsx,shared/navs.ts,shared/guards.tsx}` and `HrReportsRoutes.tsx`. HR must be reduced to the user/role/branch-scope surface the brief allows.
- `user_has_module_permission` still hardcodes ERP/HR module names including `payroll` — the RBAC matrix needs re-basing on microfinance modules.
- The ERP-table disposition question (rebuilt `invoices`/`bills`/`products`/`contacts` in the new DB) is still unanswered and still blocks M4.

**Last genuinely completed milestone: M1 (environment pinning).** M0 is regressed-and-unfinished, M2 not started, M3 incomplete. Everything after that is pending.

## Phase 2 — Reworked execution order

Order stays: make it run → make it clean → make it safe → then domain. One migration at a time, each ending in a report and a stop for review.

### M0 (redo). Stack repair — get SSR returning 200
- Align the TanStack package set to one matching minor (`react-start`, `start-server-core`, `start-plugin-core`, `router-plugin`, `react-router`/`router-core`), reinstall, and confirm no duplicate copies survive under `node_modules`.
- Keep `vite.config.ts` and `src/server.ts` as they are — they are correct now; the failure is dependency versions, not config.
- Gate: `curl localhost:8080` returns 200 and the shell renders; dev-server log free of resolution errors.

### M2. Dangling-import purge and dead-weight removal
- Fix `src/services/reports/reportsNav.ts` (drop retired report groups) and **delete** the 29 ERP-only architecture/AI tests rather than stubbing them.
- Remove `electron/`, `packages/`, `agent/` and their eslint/CI hooks.
- Gate: typecheck + build + test suite green, app still boots.

### M2b. Payroll excision (new — required by the parent brief)
- Delete `PayrollRoutes` and every payroll nav/guard/report reference; reduce HR to accounts, roles, branch assignment, officer assignment, audit.
- Re-base `user_has_module_permission`'s module list on microfinance modules (clients, lending, collections, payments, finance, reports, settings, team) and drop payroll/ERP entries.
- Gate: no `payroll` identifier remains in `src/apps`; permission function returns correct answers for the microfinance module set.

### M3 (close out). PIN auth + RBAC completion
- Migration: add `has_user_pin()` and `check_pin_status()` as security-definer RPCs matching what `usePINLogin.ts` expects (existence, active flag, lockout state, attempts remaining) with execute granted to `authenticated`/`anon` exactly as the login flow needs and nothing more.
- Sign up `fredrickmureti612@gmail.com`, then run `bootstrap_super_admin` for it; record the institution org/branch seed.
- Gate: PIN sign-in end-to-end in the preview; an unauthorized module hidden in the rail *and* refused server-side.

### M4. ERP-table disposition + settings/print baseline
- Explicit KEEP / ADAPT / DROP per rebuilt ERP table — `contacts` → ADAPT to client master; `invoices`/`invoice_items`/`bills`/`bill_items`/`products` → decision recorded (see open question).
- Migration: settings/field-config baseline and the print/dispatch queue (`print_jobs` + claim/mark RPCs) the document engine's output path expects.
- Gate: company settings screen loads; one generated document flows through the queue.

### M5. Institution settings convergence
Single institution identity as configuration root, injected into report and document data contexts — no hardcoded company data in templates. Gate: one report and one document render with configured institution details.

### M6. Microfinance workspace scaffold (mock-driven, no schema)
`MICROFINANCE_APP` registry entry + `src/apps/microfinance/{MicrofinanceLayout,nav,routes}` on the existing `PlatformShell`. Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products, Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue, Arrears, Activities) · Payments · Reports · Settings. Typed fixtures only. Gate: every nav destination renders through shared list/detail/panel primitives.

### M7+. Domain migrations (order unchanged from the parent brief)
Clients → Groups → Loan Products (versioned) → Applications → Assessment/Approval → Loan entity → Schedule engine → Disbursement → Payments & configurable allocation → Arrears & Collections → Accounting integration via configured mappings → Top-ups/Restructuring → Closure/Write-off → Reporting → Documents → Audit & integrity → Final hardening.

Invariants in every domain migration: authoritative money math server-side only; business events append-only with reversal, never `UPDATE loans SET`; account mappings configurable, never hardcoded UUIDs; loan-officer/branch data scope enforced in RLS, not just UI.

## Technical notes
- No verification of shell, auth, reports or documents is meaningful until M0 yields a 200; treat any earlier "verified UI" claim as void.
- Reference SQL under `supabase/migrations/` stays read-only source text; baselines are re-derived, idempotent, and include GRANT + RLS + policy blocks per table.
- The connected project (`xwxqunklduknceoryrha`) is the only SQL target.

## Open questions
1. The connected database already holds rebuilt Sales/Purchasing tables (`invoices`, `bills`, `products`). Drop them in M4, or leave them parked and unregistered for possible reuse?
2. You asked to connect a Supabase project named **Smart Grow Empowerment**. This app is connected to project ref `xwxqunklduknceoryrha` — the one all verified schema above lives in. If "Smart Grow Empowerment" is that same project under a different display name, nothing to do. If it is a *different* Supabase project, it must be reconnected from the Cloud panel before any further migration, since that would invalidate M1 and M3.
