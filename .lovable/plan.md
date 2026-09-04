# Smart Grow Empowerment — Microfinance Platform

Authoritative execution plan. Backend: external Supabase `xwxqunklduknceoryrha`
(connected; service-role key stored). One institution, employee-operated,
ASA-style branch model: group meetings as the collection point, individual client
obligors, no joint liability. No multi-tenancy, no client portal, no payroll.

## Locked decisions (do not re-litigate)

Reused foundation: document generation engine · auth / PIN / invitation engine ·
navigation, app shell, UI system · report engine · institution settings · audit
logging · storage · finance core (Chart of Accounts, journals, GL, fiscal periods,
fixed assets, banking + reconciliation).

Permanently out: sales, purchases, POS, inventory/warehouse, CRM, projects,
HR/payroll, marketplace, consolidation, multi-tenancy, client portal, FX reporting.

Invariants:
- Financial authority is server-side: `mf_post_event` → `mf_resolve_account` →
  `post_journal_entry_atomic`. Balances, arrears and PAR are DB views.
- Every state change is a business event; never `UPDATE loans SET …`.
- Account mapping stays configurable; no account UUIDs in React.
- One migration = one object group, FK-ordered, verified before the next.
- Retarget mature engines; never write a second implementation.
- No work outside microfinance scope: no audits, docs or polish of ERP leftovers.

## Verified state (2026-09-04, re-read from codebase + live DB by the new owner)

- Apps: `dashboard, finance, lending, platform, reports, studio`. `src/apps/lending`
  holds clients, groups, products, applications, loans, collections, documents.
- DB: 275 tables, 37 views, 1,855 functions; 31 `mf_*` tables.
- Lending domain live end-to-end (clients → groups → versioned products →
  applications → assessment/approval → loans → disbursement → schedule engine →
  repayments via single `mf_record_repayment` / `mf_reverse_repayment` → collections
  → arrears/PAR → top-up / restructure / write-off / closure). Not yet exercised in a
  signed-in browser by the owner (M1).
- Report registry microfinance-only; 9 `/lending/reports/*` routes registered.
- Finance configuration retargeted (journal books, default account roles).
- Dropped so far: sales/AR chain, purchasing/AP chain, projects, cost layers,
  backorders, carriers, consolidation, HR extras, retail/POS, warehouse, scanner,
  sales pricing engine. `projects` confirmed gone from DB and code (comment hits only).
- Remaining ERP tables in DB: `contacts`, `payments`, `payment_allocations` only.
  `payments` readers: `useFiscalPeriodDetail`, `useClearableRecordedPayments`,
  `useGovernedEntityOptions`. `contacts` readers: 8 files (journal counterparty,
  command palette, entity resolver, studio catalogue, dashboard composition).
- `useDashboardComposition` still lists 34 ERP widget ids (`sales.*`, `inventory.*`,
  `payroll.*`, `purchases.*`, `lowStock`, `creditAlerts`); consumers:
  `FinanceDashboard`, `DashboardSetupGuide`.
- Typecheck clean. `GET /` → 200. Note: `@tanstack/router-core` resolves to 1.171.x
  against `react-router` 1.170.32 — dev server serves fine after restart; if a
  `_getRenderedMatches` SSR error reappears, restart the dev server before debugging.

## Milestones — one at a time, verified before the next

### M1 — Owner verification pass (open; needs the owner signed in to the preview)
Confirm: `/lending` and children open; dashboard KPIs and PAR render; one lending
report, one client statement, one repayment receipt and one disbursement
confirmation render through the shared document engine. Report any failure here.

### M5 — Dead ERP table groups (remaining: 2 steps)
5a. `payments` / `payment_allocations` — ERP customer receipts; nothing in lending
    writes them. Retarget or delete the three readers (fiscal-period detail should
    read `mf_repayments`; clearable-payments and governed-entity options drop the
    `payments` branch), then one migration drops both tables + FKs
    (`mpesa_c2b_transactions`, `transactions`, bank match columns). Same step:
    sweep the ERP widget ids out of `useDashboardComposition`.
5b. `contacts` — decision: journal-entry counterparty points at `mf_clients`
    (optional, nullable); command palette / entity resolver / studio catalogue /
    dashboard composition drop the contacts provider. Then one migration drops
    `contacts` + address/hierarchy tables. Verify journal entry create/view after.

### M7 — Orphan function purge
Drop PL/pgSQL functions whose referenced relations no longer exist, in
dependency-checked batches. Never touch `mf_*`. Confirm no trigger on a live
table depends on a function first. Target: functions well under 1,855.

### M8 — Linter posture on retained schema only
SECURITY DEFINER views, function `search_path`, anon EXECUTE revokes,
leaked-password protection. Findings on dropped tables are ignored.

### M9 — Microfinance report completion
Fill SRD gaps on the existing engine (officer/branch collection performance,
disbursement register, product performance, aging/DPD bands): server-side data,
institution-info injection, shared PDF path. No new engine.

### M10 — Microfinance documents completion
Loan agreement, repayment schedule, loan statement, disbursement confirmation,
collection receipt through the existing document engine. Confirm which already
exist under `src/apps/lending/documents` before writing any.

Closed: M2 reports, M3 money-in/out, M4 finance config, M6 FX purge, M5 sales /
purchasing / logistics / projects steps.

## Progress log (latest first)
### 2026-09-04 — Plan re-verified by new owner. Projects removal confirmed in DB
and code. Remaining ERP tables reduced to `contacts`, `payments`,
`payment_allocations`. Dashboard-widget sweep folded into M5a. Milestone M10
(documents) added so the SRD document list is tracked. Next: M5a.
### 2026-09-04 — M5 projects DONE: `projects` table, dependent triggers/functions
and `project_id` columns dropped; 9 catalogue/permission references removed.
### 2026-09-04 — M5 logistics/costing DONE; M6 closed (zero FX references).
### 2026-09-04 — M5 purchasing/AP chain DONE. M5 sales/AR chain DONE.
### 2026-09-04 — M4 closed; M3 closed; report catalogue microfinance-only.
