# Microfinance Convergence — Handover Verification (29 Aug 2026) and Reworked Plan

## Phase 1 — Independent verification of the previous engineer's claims

Everything below was checked directly against the codebase, the running dev server and the connected database in this session. Claims I could not confirm are marked false or unproven.

| Previous claim | Verified reality |
| --- | --- |
| "App boots 200, typecheck clean, PIN probe verified on the login screen" | **FALSE today.** `http://localhost:8080/` returns **500** (the fallback "This page didn't load" shell). Dev-server log shows `Cannot find module '../dist/babel.cjs'` from `@tailwindcss/vite` → `jiti/lib/jiti.mjs`. Installed `jiti` is **1.21.6** (ships `dist/babel.js`), while Tailwind v4's node package expects the **jiti v2** layout. Nothing rendered in the browser can be trusted while this stands. |
| TanStack stack aligned | **FALSE.** Installed versions are still split: `react-start 1.168.49`, `start-server-core 1.169.31`, `start-plugin-core 1.171.39`, `react-router 1.170.32`. This is the same class of failure that produced the earlier `#tanstack-start-plugin-adapters` error and will resurface once the Tailwind/jiti break is cleared. |
| PIN RPCs added (`has_user_pin`, `check_pin_status`, `verify_pin_full`) | **TRUE.** All three exist in the connected database, alongside `set_user_pin`, `verify_user_pin`, `verify_pin_unauthenticated`, `disable_user_pin`, `get_user_session_data`, `bootstrap_super_admin`, `is_org_admin_or_owner`, `user_has_module_permission`. |
| `pin-login` edge function replaced by a server function | **TRUE as code.** `src/lib/pinLogin.functions.ts` exists and is consumed by `PINLoginForm.tsx`, `EnhancedLoginForm.tsx`, `AdminLogin.tsx`. **Unverified at runtime** — the app does not boot, so no end-to-end PIN sign-in has actually been observed. |
| Super-admin seeded (`fredrickmureti612@gmail.com`) | **NOT DONE.** No evidence of an auth user or a `bootstrap_super_admin` run. |
| M2 dangling-import purge | **MOSTLY DONE** (improvement over the previous plan's own note): no non-test file imports `apps/sales|purchases|inventory|pos|warehouse|crm`; one test file still references them. `electron/`, `packages/`, `agent/` are gone. |
| M2b payroll excision | **NOT DONE.** Payroll still spans ~30 files: `src/apps/hr/sub/{PayrollRoutes,HrReportsRoutes}.tsx`, `src/apps/hr/{index.ts,routes.tsx,shared/navs.ts,shared/guards.tsx}`, `src/lib/apps/{registry,module-app-map,app-features,types}.ts`, `src/pages/{Employees,Dashboard,Features,Downloads}.tsx`, `src/services/events/BusinessSaga.ts`, and more. Attendance/leave/timesheet surfaces (`src/pages/leave`, attendance edge functions) are also still present, against the brief. |
| M6 microfinance workspace | **NOT STARTED.** `src/apps/` = contacts, dashboard, finance, hr, me, platform, platform-admin, reports, studio. No `microfinance`. |

**Last genuinely completed milestone: M2 (import purge), partially.** M0 is regressed, M2b not started, M3 is code-complete but runtime-unverified and unseeded.

## Phase 2 — Reworked execution order

Same discipline as the brief: one migration at a time, each ending in a migration report and a stop for review. Order: make it run → make it clean → make it safe → then domain.

### M0 (redo, blocking). Stack repair — SSR must return 200
- Pin `jiti` to `^2` (or remove the stale v1 hoist) so `@tailwindcss/vite` resolves `dist/babel.cjs`; reinstall cleanly.
- Align the TanStack set to one matching minor (`react-start`, `start-server-core`, `start-plugin-core`, `router-plugin`, `react-router`) and confirm no duplicate copies survive.
- Gate: `curl localhost:8080` → 200, shell renders in the preview, dev-server log free of resolution errors.

### M1. Re-verify what M0 unblocks (no new features)
- PIN sign-in end to end in the browser: probe → PIN entry → session. Fix whatever the previous engineer could not observe.
- Seed `fredrickmureti612@gmail.com`, run `bootstrap_super_admin`, seed the single institution org + head-office branch.
- Gate: signed-in shell with an authoritative role; one module hidden in the rail *and* refused server-side.

### M2b. Payroll / HR-product excision
- Delete `PayrollRoutes`, payroll reports, payroll nav/guard/registry/app-feature entries; reduce HR to the actor surface the brief allows: user accounts, roles, branch assignment, officer assignment, audit.
- Remove attendance / leave / timesheet routes and their edge functions from the active app; keep only neutral employee attributes that a future scale-up could reuse.
- Re-base `user_has_module_permission` on microfinance modules (clients, lending, collections, payments, finance, reports, settings, team); drop payroll/ERP module names.
- Gate: no `payroll`/`attendance`/`timesheet` identifier remains reachable from `src/apps`; permission function returns correct answers for the new module set; build + tests green.

### M3. ERP-table disposition + settings/print baseline
- Record an explicit KEEP / ADAPT / DROP for every rebuilt ERP table. Working disposition (business-reasoned, no question back to you): `contacts` → ADAPT into the client/member master; `accounts`, `journal_entries`, `journal_entry_lines`, `fiscal_periods`, `bank_accounts`, `currencies`, `exchange_rates`, `tax_*`, `audit_logs`, `document_*` → KEEP as finance/platform infrastructure; `products` → ADAPT into loan products (versioned) or drop if a purpose-built table is cleaner; `invoices`/`invoice_items` → DROP (no sales invoicing in microfinance); `bills`/`bill_items`/`payments` → KEEP as institutional expenses/AP and cash-out, which a microfinance institution genuinely needs.
- Migration: settings/field-config baseline plus the print/dispatch queue the document engine's output path expects.
- Gate: company settings screen loads; one document renders through the queue.

### M4. Institution settings convergence
Single institution identity as configuration root, injected into report and document data contexts; no hardcoded company data in templates. Gate: one report and one document render with configured institution details.

### M5. Microfinance workspace scaffold (fixtures only, no schema)
`MICROFINANCE_APP` registry entry + `src/apps/microfinance/{MicrofinanceLayout,nav,routes}` on the existing shell. Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products, Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue, Arrears, Activities) · Payments · Reports · Settings. Gate: every destination renders through shared list/detail/panel primitives.

### M6+. Domain migrations (order from the brief, unchanged)
Clients → Groups → Loan Products (versioned) → Applications → Assessment/Approval → Loan entity → Schedule engine → Disbursement → Payments & configurable allocation → Arrears & Collections → Accounting integration via configured mappings → Top-ups/Restructuring → Closure/Write-off → Reporting → Documents → Audit & integrity → Final hardening.

Invariants in every domain migration: authoritative money math server-side only; business events append-only with reversal, never `UPDATE loans SET`; account mappings configurable, never hardcoded UUIDs; loan-officer/branch data scope enforced in RLS, not only in the UI.

## Technical notes
- Treat every "verified UI" statement made before M0 passes as void — the app 500s, so none of it was observable.
- Reference SQL under `supabase/migrations/` is read-only source text; baselines are re-derived, idempotent, and always include GRANT + RLS + policy blocks per table.
- SQL target is the connected project `xwxqunklduknceoryrha`, which holds all schema verified above.

## On "connect Smart Grow Empowerment"
Project connection is changed from the Cloud panel, not from code. If **Smart Grow Empowerment** is the display name of `xwxqunklduknceoryrha`, nothing to do and this plan proceeds. If it is a *different* Supabase project, reconnect it there first — that would invalidate the PIN/RBAC schema verified above and M1/M3 would need re-running against the new database.

---

## Execution log (agent, this session)

### M1 — Institution baseline: DONE (verified)
- Migration applied: organization `Smart Grow Empowerment` (slug `smart-grow-empowerment`), 1 business, 1 head-office branch.
- `fredrickmureti612@gmail.com` granted `super_admin` (unique key is `(user_id, organization_id)` — no role in the conflict target).
- Profile `last_org_id` points at the institution.
- Verified by query: 1 org / 1 business / 1 branch / role `super_admin`.

### M1 — Runtime verification: PARTIAL (verified what is reachable)
- `/login` renders; dev server returns 200.
- PIN probe verified end-to-end in a real browser: `check_pin_status` RPC returns `{"has_pin": false, "pin_length": 0}` (200) for the seeded email — correct, no PIN enrolled yet.
- Signed-in verification is NOT possible in this sandbox: `LOVABLE_BROWSER_AUTH_STATUS=external_unmanaged` (external Supabase). Post-login flows must be confirmed by the user in the preview.
- Remaining console noise: a React `setState during render` warning from `BrowserRouter` inside the legacy SPA shell, plus some 404 asset requests. Non-fatal; tracked, not fixed.

### M2b — Payroll / HR excision: DONE for UI surfaces
Removed (routes, navs, pages, components, obsolete architecture tests):
- Time Off / leave, Attendance, work schedules, shifts, roster, devices, attendance audit & reports
- Talent (goals, reviews, competencies, development, learning, succession, merit, 9-box, quizzes)
- Recruitment, Contracts, Lifecycle, Document compliance, HR Reports workspace
- Payroll-adjacent surfaces: employee loans, benefit enrollment windows, `components/hr/payroll`
- `/me` self-service trimmed to: home, profile, documents, onboarding, account, settings, notifications, team

`/hr/*` is now the Employees foundation only (directory, departments, job positions, work locations, org chart, configuration). Employee attributes are retained on the record so the institution can scale into HR modules later without a data migration.

Verification: `tsgo --noEmit -p tsconfig.app.json` is clean (note: running it against root `tsconfig.json` checks nothing — that file is a solution file with `files: []`). Dev server serves 200 after the change.

### Next (M3) — not started
- App registry (`src/lib/apps/registry.ts`) still declares retired apps: SALES, INVENTORY, WAREHOUSE, POS, CRM, TIME_OFF, ATTENDANCE, PAYROLL, TIMESHEETS, TALENT, CONTRACTS, ORG. Their routes are gone but the install catalog still offers them — remove from the registry, `module-app-map.ts`, `app-features.ts`, install/onboarding dialogs.
- Dead hooks/services remain for removed modules (`hooks/hr/useAttendance*`, `hooks/leave/*`, talent/payroll hooks, `services/payroll/*`, attendance edge functions under `supabase/functions`).
- ERP table disposition + settings baseline, then institution settings, then the microfinance workspace scaffold.
