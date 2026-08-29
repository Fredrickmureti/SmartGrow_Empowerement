# Smart Grow Empowerment — Microfinance System on the AccrualFlow Platform

**Living plan. This file is the single authoritative status. Update it at the end of every
migration, before stopping.** Last updated: 2026-08-29 21:2x UTC.

---

## 1. What we are actually doing (read this first)

We are **not** building a microfinance app from scratch, and we are **not** auditing an ERP.

We inherited a mature, production-grade multi-tenant platform (AccrualFlow). We keep its
**universal foundation** and build the **microfinance business domain** forward on top of it.
Everything else is either left alone or removed when it gets in the way — never re-derived.

### Kept, never rebuilt (the reason we started from this codebase at all)
- **Auth + PIN sign-in** (`verify_pin_full` → magic-link exchange → session) — verified working.
- **UI / design system** — records, list/detail/panel primitives, report surfaces, tokens.
- **Navigation shell & app-driven architecture** — `src/apps/*` with registry, nav, routes,
  per-app layout, permission gating, scope switcher.
- **Document generation engine** — templates, artifacts, print/dispatch queue, PDF/CSV/XLSX.
- **Finance engine** — double-entry GL, journal entries, fiscal periods, chart of accounts,
  currencies/FX rate book, bank accounts, AR/AP subledgers, statements, reports.
- **Settings engine** — organization/business/branch configuration (identity, logo, currency,
  financial settings) injected into every report and document context.
- **RBAC + permission model**, audit logging, reversal architecture, idempotency patterns.

### Built new (the actual product work)
The lending domain: clients → groups → loan products → applications → assessment/approval →
loans → schedules → disbursement → repayments → arrears/collections → accounting postings →
restructuring/write-off → reports and documents.

### Client posture
The client explicitly wants a **simple** system. Deliverables they gave are shallow and
directional. Do not gold-plate: implement the lending lifecycle cleanly on the existing
platform, resist re-importing ERP complexity (inventory, POS, manufacturing, payroll,
procurement) that the domain does not need.

---

## 2. Current status

| Milestone | State |
| --- | --- |
| **M0 — Runtime repair** | **DONE.** Cause was stale Vite optimize/SSR caches + leftover `vite.config.ts.timestamp-*.mjs`, *not* a TanStack version skew (versions are legitimately mixed and correct). `GET /` → 200, shell hydrates, `tsgo --noEmit` clean. |
| **M0b — Runtime smoke guard** | **DONE.** `src/__tests__/runtime.smoke.test.ts` — single-copy TanStack assertions + live `GET /` check (skips when no server). 3/3 green. |
| **M1 — PIN sign-in + shell** | **PASS for auth.** Drove `/login` → email probe → PIN → `pinLogin` server fn → session → `/home` in a headless browser as `fredrickmureti612@gmail.com` (`super_admin`). Throwaway PIN was set and the original bcrypt hash restored byte-for-byte, `failed_attempts = 0`. |
| **M1 blocker — hollow database** | **RESOLVED.** Root cause: of 2,893 files in `supabase/migrations`, only the 11 authored 2026-08-29 had ever been applied. The other 2,882 existed as files only, so the shell queried 361 tables against a 42-table database. |
| **SQL history replay** | **DONE.** All 2,882 inherited migrations replayed chronologically, statement by statement, skipping already-existing objects (3 passes + a 197-column backfill, because the Aug-29 baseline had created narrower versions of `organizations`, `journal_entries`, `exchange_rates`, `bills`, `contacts`, `document_*`). Result: **842 tables, 126 views, 3,085 functions, 2,072 policies** — 874 of the 948 objects the history defines. The 74 missing are POS/payroll/spreadsheet/e-sign/RFQ leftovers, i.e. outside the foundation. |
| **M2 — dangling-import purge** | **DONE** (see `docs/microfinance/migration-status.md`). |
| **M1 re-verification after replay** | **NOT DONE — this is the immediate next step.** |

### Known open items (tracked, not blocking)
1. **Temporary replay helper still exists**: `public.__replay_exec` (SECURITY DEFINER,
   `service_role` only). **Must be dropped** in its own small migration.
2. **Inherited security posture**: 1 public table without RLS, 29 SECURITY DEFINER views, a
   view exposing `auth.users`, anon-executable `check_pin_status`, leaked-password protection
   off. Triage before go-live; each finding fixed or justified in security memory.
3. Minor column drift between the Aug-29 baseline and inherited DDL may still surface at
   runtime (e.g. `exchange_rates` / `user_security_preferences`). Fix on sight, one migration
   each.

---

## 3. Working rules (non-negotiable)

- **One migration at a time.** Each ends with a report — Objective / Changed / Preserved /
  Removed / Adapted / Database / Verification / Result / Next — then stop for review.
- **No migration starts before the previous gate passes in a live browser**, not in a build log.
- **Migrations are small and single-purpose.** One object each. Large multi-object migrations
  have destabilised this database before. Never batch.
- **Every new public table ships `GRANT` + `ENABLE ROW LEVEL SECURITY` + policies in the same
  migration**, in that order.
- **Verify, don't inherit claims.** Re-check any status you did not personally produce.
- **FX:** one rate book, one resolver (`resolve_exchange_rate` / `require_exchange_rate`).
  Never `COALESCE(rate, 1)`. A missing rate is an absence, never 1:1.
- **Update this file** at the end of every step.

---

## 4. Chronological roadmap to the end goal

### M1r. Post-replay shell re-verification — **NEXT**
Sign in by PIN, walk `/home`, one report surface, one document surface. Confirm the
"Failed to load businesses" cascade is gone and no 404/400 table errors remain in the console.
Fix only what this exercise breaks. Drop `public.__replay_exec` in the same wave.
**Gate:** signed-in shell clean in console; one report and one document render.

### M2b. Residue closure outside `src/apps`
Remove timesheet / attendance / kiosk / statutory-payroll code still reachable from live routes
in `src/lib`, `src/hooks/hr`, `src/components/employees`, `src/pages/hr`, `src/test`, plus
registry and SMS-variable references. Employees survive only as **system actors** (user, role,
branch, loan-officer assignment, audit) — no compensation concepts.
**Gate:** no payroll/timesheet identifier reachable from a live route; build and tests green.

### M3. ERP disposition — code surfaces first, then tables
- **KEEP** (platform + finance infrastructure): `accounts`, `journal_entries`,
  `journal_entry_lines`, `fiscal_periods`, `bank_accounts`, `currencies`, `exchange_rates`,
  `tax_*`, `audit_logs`, `document_*`, `format_registry`, `output_dispatch_log`,
  `permission_*`, `user_*`, `profiles`, `organizations`, `businesses`, `branches`.
- **KEEP as institutional AP/expense** (an MFI does buy things): `bills`, `bill_items`,
  `payments`.
- **ADAPT:** `contacts` → client/member master.
- **DROP:** `invoices`, `invoice_items`, `products` — only after the sales/product code
  surfaces are retired in the same wave; one table per small migration.
**Gate:** routing parity green; company settings loads; one document renders through the
print/dispatch queue.

### M4. Institution settings convergence
One institution as configuration root — identity, legal, contact, logo, currency, financial
settings — injected into report and document data contexts. No hardcoded company data in any
template.
**Gate:** one report and one document render with configured institution details.

### M5. Chart of accounts + configurable account mapping
Seed the microfinance CoA — loan principal receivable, interest receivable, interest income,
fee income, penalty income, cash / bank / mobile money, write-off expense, loan-loss provision
— plus the mapping table every later business event resolves against.
**No account UUID ever appears in domain code.**
**Gate:** mappings editable in settings; a dry-run event resolves to real accounts.

### M6. Microfinance workspace scaffold (fixtures only, no schema)
`MICROFINANCE_APP` registry entry plus `src/apps/microfinance/{MicrofinanceLayout,nav,routes}`
on the existing shell. Nav: Dashboard · Clients (All Clients, Groups) · Lending (Loan Products,
Applications, Assessments, Loans, Schedules, Disbursements) · Collections (Due Today, Overdue,
Arrears, Activities) · Payments · Reports · Settings.
**Gate:** every destination renders through the shared list/detail/panel primitives.

### M7+. Domain migrations, strictly in this order
1. **Clients** — KYC identity, branch + officer scope, status lifecycle, documents.
2. **Groups** — group membership, guarantors, group meetings.
3. **Loan products** — versioned: interest method, term, fees, penalties, grace, cycles.
4. **Applications** — capture against a product version.
5. **Assessment / approval** — maker/checker, limits, decision audit.
6. **Loan entity** — issued from an approved application, immutable product-version snapshot.
7. **Schedule engine** — deterministic, server-owned amortisation; regenerate never mutate.
8. **Disbursement** — idempotent, cash/bank/mobile money, GL posting via M5 mappings.
9. **Payments & configurable allocation** — penalty → fees → interest → principal, configurable.
10. **Arrears & collections** — ageing buckets, due-today/overdue queues, follow-up activities.
11. **Accounting integration** — every business event posts through the M5 mappings only.
12. **Top-ups / restructuring / rescheduling.**
13. **Closure / write-off / loan-loss provisioning.**
14. **Reporting** — portfolio at risk, disbursement, collection, officer performance, arrears.
15. **Documents** — loan agreement, repayment schedule, client statement, receipts.
16. **Audit & integrity** — reconciliation between subledger and GL.
17. **Final hardening** — security linter triage, RLS proofs, performance.

---

## 5. Architectural invariants carried into every domain wave

- Branch + loan-officer data scope enforced **in RLS**, introduced with the client domain, never
  retrofitted.
- Maker/checker separation on approval and disbursement, enforced server-side.
- Idempotency keys on disbursement and payment events.
- Backdating and period-lock policy honouring `fiscal_periods` and organization lock dates.
- Reversal-only correction model for every posted financial event, with reason and audit link.
- Day-close / cashier till reconciliation for cash collections.
- Authoritative money math **server-side only**; business events are append-only —
  never `UPDATE loans SET ...`.
- Every posting resolves accounts through the M5 mapping table.

---

## 6. Reference material

- `docs/microfinance/migration-status.md` — M0–M2 detail and the replay post-mortem.
- `docs/microfinance/isolation-check.md` — target project `xwxqunklduknceoryrha`; the
  AccrualFlow reference project `jkszmrroyjfdwokbkzis` is read-only text, never a SQL target.
- `.lovable/plan/microfinance-*.md` — archived audits; **superseded by this file** where they
  disagree.
- `mem/index.md` and `mem/features/*` — binding product and architecture rules.

---

## 7. Instruction to the next agent

Start at **M1r**. Do not re-audit what section 2 records as DONE unless a gate fails in front of
you. Do not restart the plan, do not re-scope, do not wander into ERP domains. Work the roadmap
in order, one migration per turn, gate it live, then update this file.
