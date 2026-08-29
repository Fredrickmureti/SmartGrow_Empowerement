# Microfinance Convergence — Verified Status and Reworked Execution Plan

## Phase 1 — What I verified myself (2026-08-29)

I checked the previous engineer's claims directly against the codebase, the dev server and the connected database. Verdict summary:

| Claim | Reality |
| --- | --- |
| Step 0 "project pinning & safety check" | **NOT DONE.** `supabase/config.toml` still reads `project_id = "jkszmrroyjfdwokbkzis"` (the AccrualFlow reference project). |
| ERP module deletion pass | **PARTIALLY DONE.** `src/apps/{sales,purchases,inventory,pos,warehouse,crm,projects,timesheets,sms}` and their feature folders are gone, but ~30+ retained files still import them (`src/pages/Invoices.tsx`, `Bills.tsx`, `CreditNotes.tsx`, `src/contexts/SalesScanContext.tsx`, `src/hooks/useBillMatch.ts`, document line components, many architecture tests). `electron/`, `packages/desktop/`, `agent/` still present. |
| Platform baselines 1–6 applied | **MOSTLY TRUE for schema shape.** Live DB has orgs/businesses/branches/profiles/user_roles/audit_logs, accounts/journals/fiscal periods/tax/currencies/bank accounts, and the full document engine (records, templates, AST, artifacts, theme, print policies, dispatch log, media profiles, format registry). |
| Microfinance workspace scaffold | **NOT STARTED.** No `src/apps/microfinance`, no registry entry, no nav, no mocks. |
| "Only a build failure remains" | **UNDERSTATED — the app does not run at all.** `http://localhost:8080` returns 500: `Cannot find module '#tanstack-start-entry'`. Root cause: the repo is half-migrated between stacks. `vite.config.ts` is still the legacy SPA config (plain `defineConfig` from `vite`, react-swc, PWA, no `tanstackStart`), while `src/server.ts` calls the removed pre-v1 API `createStartHandler` from `@tanstack/react-start/server`. Both `src/App.tsx`/`src/pages` (SPA) and `src/routes` (file routes) coexist. |

Additional problems the previous plan did not record:

- **PIN auth cannot work against the live DB.** `user_pins` exists with zero policies and no grants (SELECT/INSERT/UPDATE/DELETE all denied), so the PIN login/setup components have no reachable data path.
- **Dangling FK-by-convention.** `organization_invitations.permission_group_ids` is populated by the invitation flow, but no `permission_groups`/permission-assignment tables exist. The RBAC baseline is therefore incomplete, not complete.
- **ERP tables were rebuilt into the new DB** (`invoices`, `invoice_items`, `bills`, `bill_items`, `products`, `contacts` typed customer/vendor) even though the plan classified Sales/Purchasing as REMOVE. This must be resolved explicitly (adapt `contacts` → client master, drop or park the rest) rather than left ambiguous.
- No `print_jobs`/dispatch queue, no settings/field-config tables, no microfinance domain tables.

Conclusion: the last **genuinely** completed milestone is "platform + finance + document-engine baseline schema exists in the connected project". Everything else — pinning, clean removal, a booting application, RBAC completeness, PIN auth, the microfinance workspace — is pending.

## Phase 2 — Reworked plan

Nothing below invents microfinance business logic yet. The order is deliberately: make it run → make it safe → make it clean → then domain.

### M0. Stack repair — get the application booting (blocking, no DB work)
- Decide and commit to one stack. The platform target is TanStack Start: replace `vite.config.ts` with `defineConfig` from `@lovable.dev/vite-tanstack-config`, and rewrite `src/server.ts` to the v1 entry shape.
- Reconcile the SPA remnants: `src/App.tsx` + `src/pages/*` are reachable only through the legacy router. Keep them compiling as parked code (or route them through `src/routes/-lazyRoutes.tsx`) — no page rewrites in this migration.
- Gate: `http://localhost:8080` renders, build log clean.

### M1. Environment pinning & isolation
- Rewrite `supabase/config.toml` to the connected project ref `xwxqunklduknceoryrha`; confirm `.env` VITE_ vars point at the same project; assert no code path references the AccrualFlow ref.
- Gate: a written isolation check (URL, ref, keys, storage) in `docs/microfinance/isolation-check.md`.

### M2. Dangling-import purge (finish the deletion pass)
- Fix or park every retained file importing a deleted module (list above). Delete the ERP-only architecture tests rather than stubbing them. Remove `electron/`, `packages/desktop/`, `agent/` and their eslint/CI hooks.
- Gate: typecheck + build + test suite green, app still boots.

### M3. RBAC & PIN auth completion (DB + code)
- Migration: permission groups + role/permission/app-access tables the invitation and app-registry code already expect; grants, RLS, `has_role`-style helpers reused.
- Migration: `user_pins` grants + owner-scoped RLS policies (self-manage only), lockout fields honoured server-side; PIN verification must be a security-definer RPC, never a client-side hash comparison.
- Seed `fredrickmureti612@gmail.com` as the development super administrator.
- Gate: sign in with PIN end-to-end in the preview; unauthorized app hidden in the rail and refused server-side.

### M4. ERP-table disposition & settings baseline
- Explicit KEEP / ADAPT / DROP decision per rebuilt ERP table (`contacts` → ADAPT to client master; `invoices`/`bills`/`products` → drop or park with rationale recorded).
- Migration: settings/field-config baseline (`default_account_settings`, `payment_terms`, `saved_views`, `entity_field_configs`/`values`, `form_layouts`, `notifications`) and the print/dispatch queue (`print_jobs` + claim/mark RPCs) that the document engine's output path expects.
- Gate: company settings screen loads and its values reach a generated document; document print/queue path exercised once.

### M5. Company / institution settings convergence
- Single institution identity as the configuration root, injected into report and document data contexts (no hardcoded company data in templates).
- Gate: one report and one document rendered with configured institution details.

### M6. Microfinance workspace scaffold (mock-driven, no schema)
- `MICROFINANCE_APP` registry entry + `src/apps/microfinance/{MicrofinanceLayout,nav,routes}` on the existing `PlatformShell`.
- Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products, Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue, Arrears, Activities) · Payments · Reports · Settings.
- Typed fixtures only, in `src/apps/microfinance/mocks/`. No tables invented for UI convenience.
- Gate: every nav destination renders through the shared list/detail/panel primitives.

### M7+. Domain migrations (unchanged order from the parent brief)
Clients → Groups → Loan Products (versioned) → Applications → Assessment/Approval → Loan entity → Schedule engine → Disbursement → Payments & configurable allocation → Arrears & Collections → Accounting integration via configured account mappings → Top-ups/Restructuring → Closure/Write-off → Reporting → Documents → Audit & integrity → Final hardening.

Invariants carried into every domain migration: authoritative money math server-side only; business events are append-only with reversal, never `UPDATE loans SET`; account mappings configurable, never hardcoded UUIDs; loan officer/branch data scope enforced in RLS, not just in the UI.

### Rules of execution
One migration at a time. Each ends with a report (Objective / Changed / Preserved / Removed / Adapted / Database / Dependencies / Verification / Result / Next) and stops for review.

## Technical notes
- Stack repair (M0) must precede everything: no verification of shell, auth, reports or documents is meaningful while SSR 500s.
- Reference SQL under `supabase/migrations/` (2,882 files) stays read-only source text; baselines are re-derived, idempotent, and include GRANT + RLS + policy blocks per table.
- The connected project stays the only SQL target; AccrualFlow's project is never touched.

## Open question
The connected database already contains rebuilt Sales/Purchasing tables. Confirm whether I should drop them in M4 or leave them parked (unregistered, unused) for possible later reuse.


================LAST MESSAGE THE AGENT GAVE BEFORE ITS TIME RUN OUT SO IT WAS NOT ABLE TO UPDATE THIS PLAN FILE STATUS HENCE VERIFICATION IS REQUIRED=================

M3 (RBAC + PIN) is partly landed. Two migrations were applied and verified:

- Created `permission_groups`, `permission_group_rules`, `member_permission_groups`, `user_security_preferences` with grants + owner/admin-scoped RLS; added the missing `user_pins` policies (owner-only).
- Added `is_org_admin_or_owner`, `user_has_module_permission`, `set_user_pin`, `verify_user_pin`, `verify_pin_unauthenticated` (service-role only, 5-attempt/15-min lockout), `disable_user_pin`, `get_user_session_data`, `set_last_org_id`, `bootstrap_super_admin`.
- Tightened execute privileges so `anon` cannot call any of the new definer functions; the 12 remaining linter warnings are the intentional authenticated-callable RLS/PIN helpers (all self- or membership-scoped).

Remaining for M3:
1. `bootstrap_super_admin('fredrickmureti612@gmail.com')` returned "No such user" — the account must sign up first, then re-run it (no orgs/users exist yet).
2. `has_user_pin()` and `check_pin_status()` RPCs are still missing; `src/hooks/security/usePINLogin.ts` calls them, so PIN status checks will fail until they're added.
3. Update `docs/microfinance/migration-status.md` to record M3, and add the security-memory note about the accepted definer-function warnings.


M3 is mostly in place: the access-group tables, `user_pins` policies, PIN lifecycle functions, session RPC, and privilege tightening are all applied and verified against the database.

Still open before M3 can be closed:
1. `has_user_pin()` and `check_pin_status()` RPCs need to be added — `usePINLogin.ts` calls them today.
2. `bootstrap_super_admin('fredrickmureti612@gmail.com')` must be re-run after that account signs up (no auth users or organizations exist yet).
3. `docs/microfinance/migration-status.md` needs the M3 entry, plus a security-memory note recording that the 12 authenticated-callable SECURITY DEFINER warnings are intentional RLS/PIN helpers.

Want me to continue with those three items in a new request?