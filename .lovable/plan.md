# Microfinance Convergence — Verified Handover (29 Aug 2026, 17:3x UTC) and Reworked Plan

## Phase 1 — What I verified myself this session

Every line below comes from a direct check (files, dev-server log, database query) made now. Prior claims were treated as unverified.

| Item | Verified reality |
| --- | --- |
| App boots | **FALSE.** `http://localhost:8080/` returns **500**. Cause today is *not* the jiti/Tailwind break the previous note blamed: the SSR log shows `The requested module '@tanstack/router-core' does not provide an export named '_getRenderedMatches'`. |
| TanStack versions aligned | **FALSE.** Installed: `react-start 1.168.49`, `start-server-core 1.169.31`, `start-plugin-core 1.171.39`, `react-router 1.170.32`. This skew is exactly what produces the missing-export crash. |
| Database is the Microfinance one | **TRUE.** Connected project `xwxqunklduknceoryrha` holds exactly one organization: **Smart Grow Empowerment**. Nothing AccrualFlow-operational is in it. |
| Initial user seeded | **TRUE (new since the last note).** `fredrickmureti612@gmail.com` exists in auth, has a profile, and holds an **active `super_admin`** role on Smart Grow Empowerment. |
| PIN auth backend | **TRUE.** `has_user_pin`, `check_pin_status`, `verify_pin_full`, `set_user_pin`, `verify_pin_unauthenticated`, `disable_user_pin` all present; `src/lib/pinLogin.functions.ts` is the server-function path used by the login forms. Still **never observed end to end**, because the app 500s. |
| Payroll / attendance / leave excision | **SUBSTANTIALLY TRUE.** `src/apps/hr` is now only `EmployeesRoutes`; no payroll/leave/attendance/timesheet routes, pages, hooks or services remain; `module-app-map` entries are emptied. Residue: explanatory comments across ~20 files, and two live edge functions `reverse-payroll`, `reverse-payroll-payment`. |
| Chart of accounts / finance data | **EMPTY.** `accounts` = 0 rows. Finance schema exists; no institutional CoA has been established. |
| Microfinance workspace | **NOT STARTED.** `src/apps` = contacts, dashboard, finance, hr, me, platform, platform-admin, reports, studio. |

**Last genuinely completed milestone: the HR/payroll excision (M2b/M3b) plus the seed of the super-admin and institution.** The blocker is the runtime: nothing that renders has been verified.

## Phase 2 — Reworked execution order

One migration at a time. Each ends with a migration report (Objective / Changed / Preserved / Removed / Adapted / Database / Dependencies / Verification / Result / Next) and a stop for review.

### M0 (blocking). Runtime repair — SSR must return 200
Align the whole TanStack set (`react-start`, `router-core`, `react-router`, `start-server-core`, `start-plugin-core`, `router-plugin`) to one compatible release and remove duplicate copies. Re-check `jiti`/Tailwind only if a new resolution error appears after the alignment.
Gate: `curl localhost:8080` → 200, shell renders in the preview, dev-server log clean, typecheck clean.

### M1. Runtime re-verification of what already exists
PIN sign-in driven end to end in a real browser (probe → PIN → session → shell) as the seeded super admin. Confirm the app shell, navigation, permissions and one report/document surface actually render. Fix only what that exercise breaks.
Gate: signed-in shell with an authoritative role; one module hidden in the rail **and** refused server-side.

### M2. Excision residue closure
Delete `reverse-payroll` / `reverse-payroll-payment` edge functions, purge stale payroll/attendance/leave prose from registry and app comments, and re-base `user_has_module_permission` on the microfinance module set (clients, lending, collections, payments, finance, reports, settings, team) instead of ERP/HR module names.
Gate: no payroll/attendance/timesheet identifier reachable from `src/apps` or the functions directory; permission function returns correct answers for the new module set; build + tests green.

### M3. ERP table disposition + settings/print baseline
Explicit KEEP / ADAPT / DROP per existing table, business-reasoned:
- KEEP (platform/finance infrastructure): `accounts`, `journal_entries`, `journal_entry_lines`, `fiscal_periods`, `bank_accounts`, `currencies`, `exchange_rates`, `tax_*`, `audit_logs`, `document_*`, `permission_*`, `user_*`, `organizations`, `businesses`, `branches`.
- ADAPT: `contacts` → client/member master.
- KEEP as institutional AP/expense (a microfinance institution genuinely buys things and pays suppliers): `bills`, `bill_items`, `payments`.
- DROP: `invoices`, `invoice_items`, `products` (sales invoicing and stock products have no microfinance business event; loan products get a purpose-built versioned table in M8).
Plus the settings/field-config baseline and the print/dispatch queue the document engine expects.
Gate: company settings screen loads; one document renders through the queue.

### M4. Institution settings convergence
Single institution identity as the configuration root, injected into report and document data contexts; no hardcoded company data in templates.
Gate: one report and one document render with configured institution details.

### M5. Chart of accounts baseline
Seed a microfinance CoA (loan principal receivable, interest receivable, interest income, fee income, penalty income, cash/bank/mobile money, write-off expense, loan loss provision) and the **configurable account-mapping** table that later business events resolve against. No account UUID ever appears in domain code.
Gate: mappings editable in settings; a dry-run event resolves to real accounts.

### M6. Microfinance workspace scaffold (fixtures only, no schema)
`MICROFINANCE_APP` registry entry + `src/apps/microfinance/{MicrofinanceLayout,nav,routes}` on the existing shell. Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products, Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue, Arrears, Activities) · Payments · Reports · Settings.
Gate: every destination renders through shared list/detail/panel primitives.

### M7+. Domain migrations (order from the brief)
Clients → Groups → Loan Products (versioned) → Applications → Assessment/Approval → Loan entity → Schedule engine → Disbursement → Payments & configurable allocation → Arrears & Collections → Accounting integration via the M5 mappings → Top-ups/Restructuring → Closure/Write-off → Reporting → Documents → Audit & integrity → Final hardening.

### Additions I am appending to the plan (not in the previous version)
- **Branch + loan-officer data scope in RLS**, introduced with the client domain rather than retrofitted — an officer must not read another portfolio's clients even via the API.
- **Chart of accounts + mapping table as their own migration (M5)**, ahead of any domain module, so no loan code is ever written against a hardcoded account.
- **Maker/checker separation** on approval and disbursement: the approving user cannot be the disbursing user; enforced server-side.
- **Idempotency keys** on disbursement and payment events to prevent double posting under retry.
- **Backdating and period-lock policy**: financial events must respect `fiscal_periods` / lock dates rather than silently posting into closed periods.
- **Reversal-only correction model** for every posted financial event, with an explicit reversal reason and audit link.
- **Day-close / cashier till reconciliation** for cash collections, which a startup MFI needs from day one.

## Invariants in every migration
Authoritative money math server-side only; business events append-only with reversal, never `UPDATE loans SET`; account mappings configurable; loan-officer/branch scope enforced in RLS, not only in the UI; every new public table ships GRANT + RLS + policies in the same migration.

## On "connect Smart Grow Empowerment"
No action needed. The connected project `xwxqunklduknceoryrha` already contains the single organization **Smart Grow Empowerment** with the seeded super admin, and holds all the schema verified above. Project connection is switched from the Cloud panel, not from code — if a *different* Supabase project is meant, say so, because that would invalidate the PIN/RBAC/finance schema and force M1–M5 to be re-run there.
