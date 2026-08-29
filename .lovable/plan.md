# Microfinance Convergence — Handover Verification (29 Aug 2026, 20:0x UTC) and Reworked Plan

## On "connect Smart Grow Empowerment"

Already connected. The attached Supabase project holds exactly one organization — **Smart Grow Empowerment** — with the PIN/RBAC/document/finance schema in place and no AccrualFlow operational data. Nothing to change in code; the project binding is switched from the Cloud panel, not from the codebase.

## Phase 1 — What I verified directly this session

Every line below is a check I ran now (HTTP probe, dev-server log, dependency tree, file search, database query). Prior claims were treated as unverified.

| Claim carried over | Verified reality |
| --- | --- |
| M0 runtime repair done, `GET /` → 200 | **FALSE.** `GET http://localhost:8080/` returns **500**. SSR dies with `The requested module '@tanstack/router-core' does not provide an export named '_getRenderedMatches'`. |
| TanStack versions aligned | **FALSE.** `react-start 1.168.49`, `react-router 1.170.32`, `router-plugin 1.168.35`, but `router-core 1.171.27` and `start-plugin-core 1.171.39` resolved in `node_modules` — a mixed tree, which is exactly what produces the missing-export crash. |
| Reports registry cleaned of inventory/POS/project reports | **TRUE.** No `stock-reports` / `pos-reports` / `inventory-valuation` identifiers remain outside `src/lib/apps/registry.ts`. |
| Database is the Microfinance one | **TRUE.** 1 organization, 42 public tables, `contacts` = 0, `invoices` = 0, `products` = 0, **`accounts` = 0**, zero `loan*` tables. |
| Payroll/attendance excision complete | **PARTIALLY TRUE.** Clean inside `src/apps`, but live timesheet/kiosk/attendance references remain in `src/lib`, `src/hooks/hr`, `src/components/employees`, `src/pages/hr`, `src/test`. |
| Microfinance workspace started | **FALSE.** `src/apps` = contacts, dashboard, finance, hr, me, platform, platform-admin, reports, studio. No lending domain anywhere. |
| Sales/product surfaces retired | **FALSE.** ~38 source files still query `invoices` / `products`. |

**Last genuinely completed milestone: the reports-registry half of M3.** M0 has regressed and the application does not render at all, so nothing downstream — PIN login included — has ever been observed working end to end.

## Phase 2 — Reworked execution order

One migration at a time. Each ends with a report (Objective / Changed / Preserved / Removed / Adapted / Database / Dependencies / Verification / Result / Next) and a stop for review. No migration starts before the previous one's gate passes in a live browser, not in a build log.

### M0 (blocking, redo). Runtime repair
Align the entire TanStack set — `react-start`, `react-router`, `router-core`, `start-server-core`, `start-plugin-core`, `router-plugin` — to one compatible release with a single copy of each in the tree, then pin them. Clear stale Vite caches and the leftover `vite.config.ts.timestamp-*` artifacts.
Gate: `GET /` → 200, shell paints in the preview, dev-server log clean, typecheck clean.

### M0b. Runtime smoke guard
A small test that boots the route tree and asserts the shell renders and the PIN probe answers, so an M0-class regression surfaces immediately instead of three migrations later.

### M1. Runtime re-verification of the inherited platform
Drive PIN sign-in end to end as the seeded super admin (probe → PIN → session → shell). Confirm navigation, permission gating, one report and one document surface actually render. Fix only what that exercise breaks.
Gate: signed-in shell with an authoritative role; one module hidden in the rail **and** refused server-side.

### M2b. Residue closure outside `src/apps`
Trace, then remove the timesheet / attendance / kiosk / statutory-payroll code still living in `src/lib`, `src/hooks/hr`, `src/components/employees`, `src/pages/hr`, `src/test`, plus registry and SMS-variable references. Employee records survive only as system actors (user, role, branch, officer assignment, audit) — no compensation concepts.
Gate: no payroll/timesheet identifier reachable from a live route; build and tests green.

### M3. ERP disposition — code surfaces first, then tables
Business-reasoned classification, executed in dependency order:
- **KEEP** (platform + finance infrastructure): `accounts`, `journal_entries`, `journal_entry_lines`, `fiscal_periods`, `bank_accounts`, `currencies`, `exchange_rates`, `tax_*`, `audit_logs`, `document_*`, `format_registry`, `output_dispatch_log`, `permission_*`, `user_*`, `profiles`, `organizations`, `businesses`, `branches`.
- **KEEP as institutional AP/expense** — an MFI genuinely buys things and pays suppliers, so bills/expenses stay while procurement-style purchasing does not: `bills`, `bill_items`, `payments`.
- **ADAPT**: `contacts` → client/member master.
- **DROP**: `invoices`, `invoice_items`, `products` — but only after the ~38 sales/product code surfaces (AR pages, dashboards, customer statements, delivery notes, command palette) are retired in the same wave, one table per small migration.
Gate: routing-parity green; company settings loads; one document renders through the print/dispatch queue.

### M4. Institution settings convergence
One institution as the configuration root — identity, legal, contact, logo, currency, financial settings — injected into report and document data contexts. No hardcoded company data in any template.
Gate: one report and one document render with configured institution details.

### M5. Chart of accounts + configurable account mapping
Seed the microfinance CoA (loan principal receivable, interest receivable, interest income, fee income, penalty income, cash / bank / mobile money, write-off expense, loan-loss provision) and the mapping table every later business event resolves against. No account UUID ever appears in domain code.
Gate: mappings editable in settings; a dry-run event resolves to real accounts.

### M6. Microfinance workspace scaffold (fixtures only, no schema)
`MICROFINANCE_APP` registry entry plus `src/apps/microfinance/{MicrofinanceLayout,nav,routes}` on the existing shell. Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products, Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue, Arrears, Activities) · Payments · Reports · Settings.
Gate: every destination renders through the shared list/detail/panel primitives.

### M7+. Domain migrations, in order
Clients → Groups → Loan Products (versioned) → Applications → Assessment/Approval → Loan entity → Schedule engine → Disbursement → Payments & configurable allocation → Arrears & Collections → Accounting integration through the M5 mappings → Top-ups / Restructuring → Closure / Write-off → Reporting → Documents → Audit & integrity → Final hardening.

### Architectural invariants carried into every domain wave
- Branch + loan-officer data scope enforced **in RLS**, introduced with the client domain, not retrofitted.
- Maker/checker separation on approval and disbursement, enforced server-side.
- Idempotency keys on disbursement and payment events.
- Backdating and period-lock policy honouring `fiscal_periods` and organization lock dates.
- Reversal-only correction model for every posted financial event, with reason and audit link.
- Day-close / cashier till reconciliation for cash collections.
- Authoritative money math server-side only; business events append-only, never `UPDATE loans SET`.
- Every new public table ships GRANT + RLS + policies in the same migration.

### Appended after this audit
- **Dependency-hygiene pass** pinned and verified as part of M0's report — the current outage is a dependency-tree problem, so it gets proven, not assumed.
- **Security-hardening migration before the domain waves**: the open linter findings (anon-executable `check_pin_status`, signed-in definer functions, leaked-password protection) triaged — each either fixed or justified in security memory.

## Immediate next step
Execute M0 only: repair the TanStack dependency tree until the shell renders, report, and stop for review.
