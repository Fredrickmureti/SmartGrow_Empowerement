# Smart Grow Empowerment — Microfinance System on the AccrualFlow Platform

**Living plan. Single authoritative status. Update at the end of every migration, before stopping.**
Last updated: 2026-08-29 (handover re-verification).

---

## 1. What we are doing (read this first)

We are converging a mature, inherited platform (AccrualFlow) into a **single-institution
microfinance system**. Not a SaaS. Not a rewrite. Not an ERP audit.

**Keep, never rebuild:** PIN auth + session, app shell / navigation / scope switcher, the
list-detail-panel UI system, the document engine (templates → artifacts → PDF/CSV/XLSX), the
finance engine (double-entry GL, journals, fiscal periods, chart of accounts, currencies/FX,
bank accounts), settings/organization configuration, RBAC + audit + reversal patterns.

**Build new:** clients → groups → loan products → applications → assessment/approval → loans →
schedules → disbursement → repayments → arrears/collections → GL postings → top-up /
restructure / write-off → reports and documents.

**Never re-import:** POS, inventory/warehouse, manufacturing, sales invoicing, procurement
workflows, payroll, timesheets, attendance, leave, subscriptions/tenant provisioning, client
portal.

**Rule for employees:** they exist only as system actors — user, role, branch, loan-officer
assignment, audit. No compensation concepts.

---

## 2. Verified current state (re-checked this handover, not inherited)

Backend: Supabase project `xwxqunklduknceoryrha` ("Smart Grow Empowerment") — already connected;
`supabase/config.toml` pinned to it; no references to the old AccrualFlow project remain in `src/`.

| Claim from previous engineer | Verdict |
| --- | --- |
| SQL history replayed onto the new database | **CONFIRMED** — 842 tables, 3,083 functions, 2,081 policies. |
| Temporary `public.__replay_exec` helper still present, must be dropped | **ALREADY GONE** — no such function exists. Item closed. |
| M0/M0b runtime repair + smoke test | **PLAUSIBLE, RE-GATE LIVE** — must be reconfirmed in a browser as part of M1r. |
| M1 "PIN sign-in verified as fredrickmureti612@gmail.com" | **FALSE for this database.** `auth.users` is empty. That test ran against the previous project. |
| M2 dangling-import purge done | **CONFIRMED in spirit** (no unresolved local imports), but see residue below. |
| Payroll / timesheet / attendance residue removed | **NOT DONE** — ~200 source files still reference those identifiers. |
| Microfinance workspace exists | **NOT STARTED** — `src/apps/` holds contacts, dashboard, finance, hr, me, platform, platform-admin, reports, studio. No `microfinance`. |
| Microfinance domain schema exists | **NOT STARTED** — the only `loan_*` tables are inherited HR staff-loan tables. |

**Additional finding not in the previous plan:** the database is schema-complete but
**data-empty** — 0 organizations, 0 businesses, 0 branches, 0 profiles, 0 accounts, 0 auth users.
Nothing in the shell can render until an institution + admin user is provisioned. This is now the
first gate, ahead of everything else.

---

## 3. Working rules (non-negotiable)

- One migration at a time; each ends with a report (Objective / Changed / Preserved / Removed /
  Adapted / Database / Dependencies / Verification / Result / Next), then stop for review.
- A gate passes in a live signed-in browser, not in a build log.
- Migrations are small and single-purpose. Never batch multi-object DDL.
- Every new public table ships `GRANT` → `ENABLE ROW LEVEL SECURITY` → policies in the same
  migration, in that order.
- No account UUID ever appears in domain code — every posting resolves through configured mappings.
- Authoritative money lives in the backend. The frontend never computes balances, interest,
  arrears, allocations or postings.
- Business events, not CRUD: disbursement, payment, reversal, write-off are events with audit,
  idempotency and immutable history. Never `UPDATE loans SET ...` to represent a lifecycle change.
- FX: one rate book, one resolver. A missing rate is an absence, never 1:1.
- Verify, don't inherit claims. Update this file before stopping.

---

## 4. Roadmap

### M1r. Institution bootstrap + signed-in shell — **NEXT**
Seed the configuration root and the first operator, then walk the shell.
- One organization / business ("Smart Grow Empowerment") + head-office branch.
- Admin user `fredrickmureti612@gmail.com` with a profile, super-admin role and a working PIN.
- Sign in by PIN in a headless browser; walk `/home`, one report surface, one document surface.
- Fix only what this exercise breaks; log each fix as its own small migration.
**Gate:** signed-in shell renders with a clean console — no 400/404 table errors, no
"Failed to load businesses" cascade.

### M2b. HR / payroll residue closure
Remove payroll, timesheet, attendance, leave and kiosk code still reachable from live routes
(`src/apps/hr`, `src/lib`, `src/hooks/hr`, `src/components/employees`, `src/pages/hr`,
`src/features/hr`, `src/test`, registry + SMS variable references). Keep the employee record as a
system actor only.
**Gate:** no payroll/timesheet/attendance identifier reachable from a live route; build + tests green.

### M3. ERP disposition — code surfaces first, then tables
- **KEEP:** `accounts`, `journal_entries`, `journal_entry_lines`, `fiscal_periods`,
  `bank_accounts`, `currencies`, `exchange_rates`, `tax_*`, `audit_logs`, `document_*`,
  `format_registry`, `output_dispatch_log`, `permission_*`, `user_*`, `profiles`,
  `organizations`, `businesses`, `branches`.
- **KEEP as institutional AP/expense** (an MFI does buy things): `bills`, `bill_items`, `payments`.
- **ADAPT:** `contacts` → client/member master.
- **DROP** only after their code surfaces are retired, one table per migration: sales invoices,
  products/inventory, POS, warehouse, procurement, subscription/tenant-provisioning tables.
**Gate:** routing parity green; settings loads; one document renders through the dispatch queue.

### M4. Institution settings convergence
One institution as configuration root — identity, legal, contact, logo, currency, financial
settings — injected into report and document data contexts. No hardcoded company data anywhere.
**Gate:** one report and one document render with configured institution details.

### M5. Chart of accounts + configurable account mapping
Seed the microfinance CoA (loan principal receivable, interest receivable, interest income, fee
income, penalty income, cash / bank / mobile money, write-off expense, loan-loss provision) plus
the mapping table every business event resolves against.
**Gate:** mappings editable in settings; a dry-run event resolves to real accounts.

### M6. Microfinance workspace scaffold (fixtures only, no schema)
`MICROFINANCE_APP` registry entry + `src/apps/microfinance/{MicrofinanceLayout,nav,routes}` on the
existing shell. Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products,
Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue,
Arrears, Activities) · Payments · Reports · Settings.
**Gate:** every destination renders through the shared list/detail/panel primitives.

### M7+. Domain migrations, strictly in this order
1. **Clients** — KYC identity, branch + officer scope, status lifecycle, documents.
2. **Groups** — membership, leader, guarantors, meetings. Group membership ≠ group loan.
3. **Loan products** — versioned: interest method, term, frequency, fees, penalties, grace, limits.
4. **Applications** — captured against a product version; requested ≠ approved amount.
5. **Assessment / approval** — maker/checker, approval authority limits, decision audit.
6. **Loan entity** — issued from an approved application with an immutable product-version snapshot.
7. **Schedule engine** — deterministic, server-owned amortisation; contractual, not a ledger.
8. **Disbursement** — idempotent, approval-gated, cash/bank/mobile money, posts via M5 mappings.
9. **Payments & allocation** — partial/over payments, reversals; allocation order **configurable**.
10. **Arrears & collections** — derived from schedule vs payments; DPD/ageing, PAR, officer queues,
    visits, promises to pay.
11. **Accounting integration** — every business event posts only through M5 mappings.
12. **Top-ups / restructuring / rescheduling** — new contractual state, history preserved.
13. **Closure / write-off / loan-loss provisioning** — approval-gated, no destructive deletion.
14. **Reporting** — portfolio, outstanding principal/interest, collections, arrears/PAR/ageing,
    client statements, disbursements, product and officer performance.
15. **Documents** — loan agreement, repayment schedule, loan statement, payment/collection
    receipt, disbursement confirmation, client statement.
16. **Audit & integrity** — subledger-to-GL reconciliation, reversal coverage, duplicate
    prevention, permission tests.

### M-Final. Security & hardening
Triage the inherited posture: 1 public table without RLS, 29 SECURITY DEFINER views, a view
exposing `auth.users`, anon-executable `check_pin_status`, leaked-password protection off. Each
finding fixed or justified in security memory. Then final dead-code removal, build, regression and
performance verification.

---

## 5. Additions this handover made to the plan

- **Institution bootstrap (M1r)** promoted to first position — the previous plan assumed a
  populated database and a working admin identity that do not exist on this project.
- **RBAC data scoping** made explicit in M7: a loan officer sees their own portfolio; branch scope
  is enforced server-side in RLS, not only hidden in the UI.
- **Reversal / idempotency** listed as first-class acceptance criteria for disbursement and
  payment, not as later hardening.
- **Security triage** given its own terminal milestone instead of living as an untracked note.
