# Smart Grow Empowerment — microfinance platform (plan of record, reworked 2026-09-03)

Backend: Supabase `xwxqunklduknceoryrha` — verified connected (`.env`, `config.toml`, `src/integrations`). It holds the `mf_*` domain (22 tables/views), 1 business, 1 user. The old ERP ref only survives in docs and historical migration comments. Nothing to connect.

## Verified state (checked in code + live DB, not the previous log)

Done and real:
- `src/apps/lending/*` — clients, groups, products (versioned), applications, assessment/approval, loans, schedule, disbursement, repayments + allocation, collections, top-up/restructure/closure events, settings, nav, routes.
- Server-owned financial state: `mf_*` tables, `mf_post_event` mapping-resolved posting, `mf_loan_balances` / `mf_loan_arrears` / `mf_par_summary` views. V1 lifecycle proof passed with balanced journals.
- Four lending reports on the inherited report engine (`/lending/reports/*`).
- Lending document snapshot builders (`src/services/documents/snapshots/lending.ts`) and PDF layouts (`supabase/functions/_shared/pdf/layouts/lending.ts`) exist.

Not done (previous log was accurate about these):
- `LENDING_LAYOUTS` is declared in `renderers/pdf.ts` but never dispatched — renders fail closed.
- No `document_kinds` rows for `lending.*`; `document_template_ast` has 0 rows and lacks the `is_active` column the resolver filters on.
- No registry entries in `resolveSourceDocumentRecord.ts`; no preview/print buttons on loan/repayment screens.
- App registry still ships ERP surfaces: HR app, ERP contacts app, Finance budgets/consolidation/statements/customer credits, plus ~40 top-level ERP pages and their hooks/tests.

## Scope decision (final — do not reopen)

Reuse: auth (PIN) engine, navigation/UI foundation, document engine, report engine, Finance posting core (COA, journals, fiscal periods, fixed assets), and — per your note — **banking, bank reconciliation, payables and receivables, retailored to microfinance** (bank/mobile-money accounts as disbursement/collection sources; receivables = loan book views, not sales invoices; payables = institution expenses/suppliers, not procurement).

Everything else is deleted, not analysed.

## Milestones, in order

### C9 — Finish lending documents (small, ~1 session)
1. `pdf.ts`: add `LENDING_LAYOUTS` to `hasDedicatedLayout()` + dispatch branch.
2. Migrations (one object each): add `document_template_ast.is_active`; four `document_kinds` rows; four system-scope template rows.
3. Registry entries for the four kinds in `resolveSourceDocumentRecord.ts`.
4. Preview / download / print actions on Loan detail (agreement, schedule, statement) and Repayment detail (receipt).
5. Gate: `tsgo --noEmit`, build OK, one live render per kind.

### C10 — Single bulk ERP removal sweep (one pass, no per-module investigation)
Delete apps/routes/nav/pages/hooks/services/tests for: HR app (keep only user + role + branch assignment inside Settings/Team), ERP contacts app (lending owns clients; suppliers stay only under Finance → Payables), budgets, consolidation, customer statements/credits, compliance/fiscal-compliance workspaces, BI page, studio if not used by documents, and any remaining sales/purchase/inventory/POS/payroll/attendance remnants (`src/pages/*`, `src/features/*`, `src/hooks/*`, edge functions: `mpesa-*` kept, `etims-*`, `paypal-*`, `pesapal`, `process-recurring-invoices`, `generate-statutory-return`, `download/generate-tax-certificate`, `filing-calendar-*`, `fiscal-compliance-saga` removed).
Finance registry after sweep: Chart of Accounts, Journal Entries, Fiscal Periods, Fixed Assets, Banking, Bank Feeds, Bank Reconciliation, Receivables, Payables, Reports, Settings.
Gate: `tsgo --noEmit` clean, build OK, `/lending/*`, Finance survivors and Settings render, sidebar shows only Dashboard / Lending / Finance / Reports / Settings.

### C11 — Retailor banking + AR/AP for microfinance
- Banking: bank + mobile-money accounts selectable as disbursement source and repayment destination; `mf_loan_disbursements` / `mf_repayments` carry the account; reconciliation matches against `mf_*` movements instead of invoices/bills.
- Receivables: replace invoice-centric screens with loan-book views fed by `mf_loan_balances` / `mf_loan_arrears` (no sales invoice tables).
- Payables: institution expenses/supplier bills only; remove PO/GRN matching paths.
- Every posting still goes through `mf_account_mappings` — no hardcoded account ids.

### C12 — Hardening
`mf_*` RLS/grants audit (officer/branch scope, approval / duplicate-disbursement / reversal controls), security scan, institution settings confirmed as the single source feeding reports + documents, DB linter re-run (post-sweep noise gone). Remove dead migration files for deleted domains only if the build/tests reference them.

## Rules (binding)
1. Financial state is derived server-side; React never owns balances, interest, arrears, allocations or journal amounts.
2. Every domain action is an append-only event with a mapping-resolved posting. History is never edited.
3. One object per migration; GRANTs + RLS in the same migration.
4. A bug in a C10 delete-list surface is not a bug — never fix, explore or document it.
5. No client portal, multi-tenancy, payroll, HR, CRM, inventory, procurement, POS, or speculative abstractions.
6. Each milestone ends with: tsgo clean, build OK, affected screens rendered, this file updated.

## Next action
C9 step 1–2: wire `LENDING_LAYOUTS` dispatch, then the `is_active` + `document_kinds` migrations.
