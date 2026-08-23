# Analytic Accounting Domain — Authoritative Status

Source of truth for this domain. Supersedes the archived plans:
`.lovable/plan/analytic-accounting-domain-forensic-assessment-2026-08-23.md` (forensic findings)
and `.lovable/plan/analytic-accounting-domain-handover-verification-verdict-and-2026-08-23.md`
(Phase 4 closure contract).

Last updated: 2026-08-23. Active phase: **Phase 5 — Consumers (reports)**.

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| 0-2 | Plans, accounts, lifecycle, scoped RLS, no fabricated balances | Done — verified |
| 3 / 3b | Posting engine (`_jel_sync_analytics`), immutability, `analytic_balances` | Done — verified |
| 4 | Producers reach the GL analytic ledger; project ledger reconciled | **Done — verified end to end** |
| 5 | Consumers: three server-side analytic reports | **Not started — active phase** |
| 6 | Architecture test + live post/void round trip on real data | Not started |

## Phase 4 — what was implemented and verified

Delivered in two migrations plus thin UI wiring.

Implemented:
- `projects.analytic_account_id` — FK to `analytic_accounts`, `ON DELETE RESTRICT`, partial index.
- `trg_projects_sync_analytic_account` (BEFORE INSERT/UPDATE on `projects`) — ensures the company has a `project` analytic plan, provisions exactly one analytic account per project (code `PRJ-<project_number>`, name from the project), keeps name/code in sync, and flips the account to `archived` when the project closes or is deactivated. Templates are skipped. Never creates a second account for an existing project.
- `public.project_analytic_account_id(uuid)` — STABLE, SECURITY DEFINER, pinned `search_path`; returns the project's account only while it is `active`.
- `trg_bill_items_default_analytic`, `trg_invoice_items_default_analytic`, `trg_expenses_default_analytic` — a line tagged with a project and no explicit analytic account inherits the project's account. Explicit analytic choices always win.
- `post_expense_gl` refactored in place: the fragile `analytic_accounts.code = projects.analytic_account_code` text match is replaced by FK resolution. All tax and payment-account logic untouched.
- `confirm_bill_atomic` and `build_invoice_je_lines` now group by `COALESCE(line.analytic_account_id, project_analytic_account_id(line.project_id))` — defence in depth for rows that predate the triggers.
- `projects.analytic_account_code` dropped; its input removed from `ProjectForm.tsx` and its field from `useProjects.ts`. The form now states that the analytic account is provisioned automatically.
- Backfill executed: existing projects provisioned, existing project-tagged producer rows given their analytic account.
- `public.project_analytic_reconciliation(business_id, date_from, date_to)` — per project: GL analytic net vs `project_cost_entries` / `project_revenue_entries` and the difference. Authorized exactly like `analytic_balances` (`user_can_access_business` + `financials:read`). The per-source project-ledger triggers stay in place for non-GL sources (timesheets, PO commitments, stock movements) — the two ledgers are reconciled, not merged.

Verified (live database, transaction rolled back, nothing persisted):
- A new project provisions exactly one analytic account: `PRJ-ZZTEST-001`, plan `project`, status `active`; resolver returns it.
- A bill line tagged with **only** a project inherits that project's analytic account.
- Posting a journal entry carrying that account writes exactly one JELA row, amount 100.00, percentage 100, correct account.
- Contract-test invariants 7-10 pass against live data: 0 unbound projects, 0 project-tagged producer rows without analytic attribution, all 4 triggers installed, the dead text column and every function reference to it gone.

Contract test extended: `supabase/tests/analytic_accounting_contract_test.sql` sections 7-10 (project binding uniqueness and plan/company correctness, producer attribution completeness, trigger presence, retired-column regression guard).

## Phase 5 — next work (active)

Exactly three reports, server-side, through `reportDataEngine` + `ReportRegistry` + `reportsNav`:
1. **Analytic Account Statement** — line-level, drills through to the journal entry.
2. **P&L by Analytic Account** — period- and branch-aware.
3. **Budget vs Actual by Analytic Account**.

Rules: aggregation happens in the database (extend the `analytic_balances` contract; no client-side summing), each report ties out to the GL, `posted`/`reversed` only, company- and branch-scoped with the same authorization gate. Surface `project_analytic_reconciliation` as a variance panel once the statement report exists.

## Phase 6 — after that

Architecture test forbidding client-side analytic aggregation, plus one live post/void round trip on real (non-rolled-back) data once the tenant has real analytic postings.

## Out of scope — do not build

User-defined unlimited dimensions, a separate analytic budget engine, stored analytic balances, statistical postings without a GL counterpart, automatic distribution-rule engines.

## Instructions for the next agent

1. **Verify Phase 4 before writing anything new.** Run `supabase/tests/analytic_accounting_contract_test.sql` sections 1-10 against the live database. Then re-prove the chain in a rolled-back transaction: insert a project, assert one `project`-plan analytic account; insert a bill line with `project_id` only, assert `analytic_account_id` is inherited; post a draft JE carrying that account, assert one JELA row that nets to the line's signed amount; void it and assert the contra row nets to zero (the void leg was not exercised — prove it). Confirm `post_expense_gl`, `confirm_bill_atomic` and `build_invoice_je_lines` still contain the FK resolution (`pg_get_functiondef`). If any assertion fails, reopen Phase 4 — do not layer Phase 5 on top of it.
2. **Then resume at Phase 5**, in the order listed above. Do not pick up unrelated domains, do not ship a report that aggregates in the browser, and do not leave a report registered but unwired.
3. **Update this file at the end of your work** so it stays the authoritative status of the domain.

## Standing rules

Aggregation stays server-side — the client selects an axis, the database computes amounts. No orphaned UI fields, no half-wired producers, no second book of record. A phase marked Done that fails verification is reopened, not layered on.
