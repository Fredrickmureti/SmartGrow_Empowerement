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


=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======
Let me check the actual state of the codebase and plan before anything else.

Paused mid-C9 — credits ran out. Here's exactly where things stand so the next session resumes without re-investigation.

Supabase: `xwxqunklduknceoryrha` is already the connected, correct target (it holds the `mf_*` tables, 1 business, 1 user). No reconnection is needed; the old ERP ref survives only in docs and historical migration comments.

Done this session (C9 steps 1–3)
- `renderers/pdf.ts`: `LENDING_LAYOUTS` now included in `hasDedicatedLayout()` and dispatched in the render function (after the warehouse branch, before the thermal gate).
- Migration 1: `document_template_ast` aligned to the registry shape — `template_id`/`organization_id` nullable, `is_active` added, scope-target check, default unique index, system/tenant rows readable by signed-in users.
- Migration 2: four `document_kinds` rows (`lending.loan_agreement`, `lending.repayment_schedule`, `lending.loan_statement`, `lending.payment_receipt`) plus one system-scope default template each.
- `resolveSourceDocumentRecord.ts`: registry entries `loan_agreement`, `repayment_schedule`, `loan_statement`, `loan_payment_receipt` mapped to the existing lending snapshot builders.

Remaining for C9
1. UI wiring — a "Documents" action on each row in `src/apps/lending/loans/LoansPage.tsx` (agreement / schedule / statement) and a "Receipt" action on posted rows in `src/apps/lending/repayments/RepaymentsPage.tsx`. Use `useDocumentPreview().preview({ documentType, documentId, title })` for preview and `downloadExport({ documentType, documentId, format: "pdf", filename })` from `@/services/exports/documentExport` for download (`useRecordDownload` is typed to `journal_entry` only — widen its kind union or call `downloadExport` directly).
2. Gate: `tsgo --noEmit`, build OK, one live render per kind.

Then C10 (bulk ERP sweep), C11 (banking/AR/AP retailored), C12 (hardening) per the approved plan. The plan file is archived at `.lovable/plan/smart-grow-empowerment-microfinance-platform-plan-of-record-2026-09-03.md`; the "Next action" line there should be updated to "C9 step 4: UI wiring" when work resumes.

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
