# Microfinance System on the AccrualFlow Platform — Reconstruction Plan

## What I verified in this codebase first

- The app shell is already a single reusable primitive: `src/components/layout/shell/` (`PlatformShell`, `AppRail`, `WorkspaceSidebar`, `WorkspaceTopBar`, `WorkspaceShellFrame`). Every workspace (Finance, Sales, HR, Dashboard...) is just `<PlatformShell app={APP} nav={NAV}>`. Adding a Microfinance workspace is a registry + nav + routes exercise, not a new shell.
- Apps are registry-driven: `src/lib/apps/registry.ts` (app + module definitions, icons, colors), plus `app-features.ts`, `capabilities.ts`, `module-app-map.ts`. Role/app access is driven from this registry.
- Auth already includes the PIN experience you want: `src/components/auth/PINLoginForm.tsx`, `PINSetupDialog.tsx`, `EnhancedLoginForm.tsx`, `MfaChallengeGate.tsx`, `OnboardingGuard.tsx`.
- Reporting is registry-driven, not hand-listed: `src/services/reports/reportsNav.ts` + a report registry feed the Finance sidebar. New report families are registry rows.
- Document generation is a pipeline, not per-page code: `src/services/documents/` (`ensureDocumentRecord`, `submitIntent`, `outputIntent`, `DocumentArtifactStore`, snapshots) with server-side data injection.
- Finance domain pieces you asked to keep exist as features: `src/features/finance/{accounts, journal-entries, fiscal-periods, fixed-assets, banking, reconciliation, budgets, year-end-close, business-transactions, record}`.
- Migration history is large: 2,882 SQL files, ~472k lines, 20 MB. Replaying them file-by-file against a fresh database is not a realistic path — many are corrective/iterative edits of earlier files, and several depend on data or storage state that no longer exists.
- Two facts to settle before any SQL runs: `supabase/config.toml` still points at project ref `jkszmrroyjfdwokbkzis` (the AccrualFlow reference), while the connected project in this workspace is a different, currently empty project. No tables, functions, triggers or buckets exist in the connected project today.

## Safety stance

Nothing in this plan touches the AccrualFlow project. All SQL is applied only to the connected empty project, and step 0 makes the codebase point at that project explicitly so there is no ambiguity. Existing files under `supabase/migrations/` are treated as read-only reference source text that we read and re-derive from — never re-run wholesale.

## Approach: consolidated baseline, executed one domain at a time

Instead of replaying 2,882 migrations, we derive a small ordered set of **baseline migrations** from the current live schema shape encoded in that history, applied in dependency order, one migration per approval, so you can verify after each. Each baseline is idempotent and includes GRANTs + RLS + policies.

```text
0  Project pinning & safety check      (no SQL)
1  Platform core        orgs, branches, profiles, roles/permissions,
                        app access, invitations, audit log, PIN auth support
2  Settings & identity  company profile, branding, numbering sequences,
                        currency/locale, settings source-of-truth tables
3  Document engine      document types, templates, records, artifacts,
                        snapshots, storage buckets, print/queue support
4  Reporting core       report registry support tables, saved filters,
                        report runs/exports
5  Finance core         chart of accounts, journals, journal entries,
                        fiscal periods, tax/GL mapping, finance settings
6  Finance extended     banking, reconciliation, fixed assets, budgets,
                        year-end close
7  Microfinance domain  (LATER — only after the domain model is agreed)
```

Steps 1–6 are platform + finance and are lifted from the reference. Step 7 is not part of this phase.

## Codebase restructuring: what stays, what goes

Keep (platform infrastructure):
- `src/components/layout/shell/*`, `src/components/ui/*`, `src/design-system/*`, `src/contexts/*` (org/branch/company scope, read-only mode, reporting basis)
- `src/components/auth/*` including the PIN flow
- `src/services/documents/*`, `src/services/reports/*`, `src/services/exports/*`, `src/services/gl/*`, `src/services/fx/*`, `src/services/events/*`
- `src/lib/apps/*` registry machinery
- `src/apps/{platform, platform-admin, dashboard, reports, finance, me}`
- `src/features/finance/*`, `src/features/localization/*`, `src/features/resources/*`

Remove (ERP domain not needed by a microfinance lender):
- `src/apps/{sales, purchases, inventory, pos, warehouse, warehouse-mobile, crm, projects, timesheets, studio, sms}` and their `src/features/*` counterparts (`sales`, `purchases`, `inventory`, `products`, `pos`, `warehouse`)
- Hardware/POS peripheral stack: `electron/`, `packages/desktop/`, `agent/`, POS/scanner docs and the eslint rules that only guard those paths
- ERP-only routes in `src/routes/-lazyRoutes.tsx` / `-LegacyRedirects.tsx`, ERP report registry rows, ERP document types

Decide case-by-case (reviewed during step 1):
- `src/apps/hr` and `src/apps/contacts` — HR is likely wanted later for employees/loan officers; Contacts overlaps with the future Client/Member master. Both are parked (kept but unregistered from the app rail) rather than deleted, so nothing is lost.

Removal happens **after** step 1 lands, in one dedicated pass, with a typecheck + build gate so we see every dangling import at once.

## Microfinance workspace scaffold (this phase, mock data)

- New `MICROFINANCE_APP` in the app registry + `src/apps/microfinance/{MicrofinanceLayout.tsx, nav.ts, routes.tsx}` using `PlatformShell` — identical chrome to Finance.
- Navigation (matches your draft, using the reference's group conventions):
  Dashboard · Clients (All Clients, Groups) · Lending (Loan Products, Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue, Arrears, Activities) · Payments · Reports · Settings
- Pages built on the existing reusable list/detail/side-panel primitives, fed by typed mock fixtures in `src/apps/microfinance/mocks/` (Mary Wanjiku, Business Development Loan, MLA-00001, LN-00001, KES 100,000, 12 months). No tables, no RPCs, no schema invented for UI convenience.
- Dashboard composed with the existing dashboard architecture but microfinance KPIs: active loans, outstanding principal/interest, today's collections, upcoming repayments, overdue amount, clients, awaiting approval, recent disbursements, PAR.
- Report and document entries registered through the existing registries (so Loan Agreement, Repayment Schedule, Loan Statement, Payment Receipt, Disbursement Confirmation, Client Statement flow through the same engine) with placeholder data providers until the domain layer exists.

## Deliverable at the end of this phase

A written reference-architecture map (findings, reuse list, rebuild list, exclude list, backend dependencies, open questions) committed to `docs/microfinance/reference-map.md`, plus a running Microfinance workspace with PIN auth, shell, navigation, dashboard and mock-driven pages on the empty new project with steps 1–6 applied.

## Explicitly out of scope until you approve a later phase

Microfinance schema, interest/allocation/arrears calculation engines, penalties, top-ups, restructuring, write-offs, accounting posting rules. Those follow the SRD-driven domain model, in the order: domain model → ERD → schema → backend logic → business rules → UI integration.

## Open questions I need answered before step 1

1. Confirm the connected empty project is the intended Microfinance database (and that I may rewrite `supabase/config.toml` to its ref).
2. Confirm the consolidated-baseline approach instead of literally replaying 2,882 files.
3. HR and Contacts: park (my recommendation) or delete now?


=================IMPLEMENTATION STATUS======================
he document/rendering baseline migration applied successfully. I've stopped here since credits ran out.

What remains:

Build failure — an async build from an earlier turn failed; the truncated log doesn't name the module, so the next step is lovable build diagnostics br_4a2b9a11-35b6-42de-9622-47259424c7dd --json to get the failing import and fix it (almost certainly another orphaned ERP import left by the deletion pass).
Security linter follow-ups from this migration — 1 table with RLS enabled but no policy, and 5 SECURITY DEFINER functions executable by signed-in users. These need review: the new ensure_document_record is intentionally callable by signed-in users (it self-checks org membership), so it should be documented in security memory; the RLS-no-policy table needs identifying and either a policy or an explicit deny rationale.
Remaining baselines — print/dispatch queue (print_jobs + claim_print_jobs / print_job_mark_* RPCs), then settings/field-config (default_account_settings, payment_terms, saved_views, entity_field_configs/values, form_layouts, notifications), then the microfinance domain model itself (loan types, loans, repayment schedules, repayments, lifecycle events).
Note: the SaaS marketplace/entitlement tables (platform_apps, plan_app_access, subscription plans, trial status) are deliberately not being rebuilt — per your "not a SaaS" constraint, that plumbing should be de-scoped rather than recreated.