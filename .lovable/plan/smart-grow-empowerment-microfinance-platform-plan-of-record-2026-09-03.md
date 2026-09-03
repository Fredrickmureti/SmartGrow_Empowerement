# Smart Grow Empowerment — microfinance platform (plan of record, 2026-09-03)

One institution, employee-operated. Backend: Supabase `xwxqunklduknceoryrha` — already connected and holding the `mf_*` domain. Nothing to connect, nothing to migrate between projects.

## Verified now (code + live DB, not the previous log)

Real and working:
- `src/apps/lending/*` — clients, groups, versioned products, applications → assessment → approval, loans, schedule engine, disbursement, repayments + policy allocation, reversals, collections/arrears, top-up / restructure / write-off / closure.
- Server-owned money: `mf_*` tables, `mf_post_event` (mapping-resolved posting, no hardcoded accounts), `mf_loan_balances` / `mf_loan_arrears` / `mf_par_summary`. V1 end-to-end lifecycle proof passed with balanced journals.
- Four lending reports on the inherited report engine (`/lending/reports/*`).
- Documents C9 steps 1–3 confirmed done: `LENDING_LAYOUTS` dispatched in `rendering/renderers/pdf.ts`, four `lending.*` rows in `document_kinds` with 4 template AST rows, registry entries in `resolveSourceDocumentRecord.ts`.

Confirmed still missing:
- No document actions in the lending UI (`rg` finds no `useDocumentPreview` / `downloadExport` under `src/apps/lending`). Documents exist but no user can produce one.
- App registry still ships ERP surfaces (HR app, ERP contacts app, budgets, consolidation, customer statements/credits, ~40 legacy pages plus hooks/tests).

## Scope decision — final, do not reopen

Reuse (retailored to microfinance, never rebuilt): auth/PIN engine, navigation + UI foundation, document engine, report engine, Finance posting core (COA, journal entries, fiscal periods, fixed assets), banking + bank feeds + reconciliation, and the payment/settlement engine behind receivables/payables.

Retailoring means: receivables = the loan book (`mf_loan_balances` / `mf_loan_arrears`), not sales invoices; statements = client/loan statements, not customer statements; payables = institution expenses and suppliers, no PO/GRN matching; banking = disbursement sources and repayment destinations, reconciliation against `mf_*` movements.

Everything else is deleted in one sweep — no per-module investigation, no audits, no documentation of dead surfaces.

## Milestones, in order

### C9 — Finish lending documents (small; the only thing left)
1. Row/detail actions: Loan (agreement, repayment schedule, loan statement) and Repayment (payment receipt), using `useDocumentPreview().preview(...)` for preview and `downloadExport(...)` from `@/services/exports/documentExport` for PDF download. `useRecordDownload` is typed to `journal_entry` — call `downloadExport` directly or widen its union.
2. Gate: `tsgo --noEmit` clean, build OK, one live render per kind.

### C10 — Single bulk ERP removal sweep (one pass)
Delete apps/routes/nav/pages/hooks/services/tests for: HR app (keep user + role + branch assignment inside Settings/Team), ERP contacts app, budgets, consolidation, customer statements/credits, compliance/fiscal-compliance workspaces, BI page, and all sales / purchase / inventory / warehouse / POS / payroll / attendance remnants, plus their edge functions (`etims-*`, `paypal-*`, `pesapal`, `process-recurring-invoices`, `generate-statutory-return`, tax-certificate and filing-calendar functions). Keep `mpesa-*`.

Finance registry after the sweep: Chart of Accounts, Journal Entries, Fiscal Periods, Fixed Assets, Banking, Bank Feeds, Bank Reconciliation, Receivables, Payables, Reports, Settings.

Gate: `tsgo --noEmit` clean, build OK, sidebar shows only Dashboard / Lending / Finance / Reports / Settings, and every surviving route renders.

### C11 — Retailor banking + AR/AP to microfinance
- Bank and mobile-money accounts selectable as disbursement source and repayment destination; `mf_loan_disbursements` / `mf_repayments` carry the account; reconciliation matches `mf_*` movements.
- Receivables screens fed by the loan book views; client/loan statements replace customer statements on the same statement engine.
- Payables limited to institution expenses and supplier bills.
- All postings continue through `mf_account_mappings`.

### C12 — Hardening
`mf_*` RLS/grants audit (officer/branch scope, approval, duplicate-disbursement and reversal controls), security scan, institution settings confirmed as the single source feeding reports and documents, DB linter re-run after the sweep.

## Rules (binding)
1. Financial state is derived server-side; React never owns balances, interest, arrears, allocations or journal amounts.
2. Every domain action is an append-only event with a mapping-resolved posting. History is never edited.
3. One object per migration; GRANTs + RLS in the same migration.
4. A bug in a C10 delete-list surface is not a bug — never fix, explore or document it.
5. No client portal, multi-tenancy, payroll, HR, CRM, inventory, procurement or POS.
6. Reuse before rebuild: if a Finance/banking/settlement engine already works, retailor it; do not re-implement it.
7. Each milestone ends with: tsgo clean, build OK, affected screens rendered, this file updated in place (no new audit documents).

## Next action
C9 step 1 — add the document preview/download actions to the Loan and Repayment screens, then run the gate.
