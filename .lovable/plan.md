# Smart Grow Empowerment — microfinance platform (reworked plan)

Backend: Supabase `xwxqunklduknceoryrha` — already connected. No second project, no new connection needed.

## Verified state (checked against the codebase, not the previous log)

Confirmed present and coherent:

- `src/apps/lending/*` — clients, groups, products, applications, loans, repayments, collections, settings, reports, routes, nav.
- Four lending reports on the inherited report engine (`portfolio`, `arrears/PAR`, `collections`, `disbursements`) + `src/hooks/useMfReports.ts`, registered under a `lending` reporting domain at `/lending/reports/*`.
- Server-owned financial state: `mf_*` tables, `mf_post_event` mapping-resolved accounting hook, server views for balances/arrears/PAR. V1 full lifecycle proof passed against the live DB (application → approval → loan + schedule → disburse → repay → reverse → top-up → successor → closure, all journals balanced).

Confirmed still ERP, still wired in (the real remaining problem): the app registry still ships Finance receivables, payables, customer credits, statements, budgets, banking, bank feeds, reconciliation; an `employees`/HR app; a `contacts` ERP app; plus ~1,770 source files and 43 top-level pages, most of them ERP.

## What remains — three milestones, in order

### C9 — Lending documents (last build item on the inherited engine)

Four kinds on the existing document engine, no new renderer, no new PDF path:
`lending.loan_agreement`, `lending.repayment_schedule`, `lending.loan_statement`, `lending.payment_receipt`.

Per kind: a `document_kinds` row + system-scope `document_template_ast` row (one migration each, per the one-object rule), one shared `pdf/layouts/lending.ts` module registered in the renderer, a client snapshot builder, and a registry entry in `src/services/documents/resolveSourceDocumentRecord.ts`. Then wire preview/download/print on the loan and repayment screens.

### C10 — One bulk ERP removal sweep (no per-module analysis)

Already decided; execute as a single pass, not investigations:

- Delete apps/routes/nav/pages/hooks/components/tests for: retail/POS, inventory, warehouse, procurement, sales/order-to-cash, CRM, payroll, attendance, HR beyond user + role + branch assignment.
- Finance registry keeps only: chart of accounts, journal entries, fiscal periods, fixed assets, reports, settings. Drop receivables, payables, customer credits, statements, budgets, banking, bank feeds, reconciliation, consolidation.
- Contacts survives only as the lending client dependency; otherwise it goes.
- Gate after the sweep: `tsgo --noEmit` clean, build OK, `/lending/*` and Finance survivors render.

### C11 — Hardening

`mf_*` RLS/grants audit (officer/branch scope, reversal + duplicate + approval controls), security scan, institution settings confirmed as the single source feeding reports and documents. The ~3,675 inherited linter findings are ERP-surface noise and die with C10 — they are not investigated individually.

## Rules (unchanged, binding)

1. Reuse only: document engine, auth engine, navigation/UI foundation, and Finance strictly as the posting target.
2. Financial state is derived server-side. React never owns balances, interest, arrears, allocations or journal amounts.
3. Every domain action is an append-only event with a mapping-resolved accounting hook. Never a hardcoded account UUID.
4. History is never edited — top-up, restructure, write-off, closure create rows.
5. One object per migration; GRANTs + RLS in the same migration.
6. A bug in a C10 delete-list surface is not a bug. Never fix, explore or document it.
7. No client portal, no multi-tenancy, no payroll, no speculative abstractions.

## Next action

C9: write `pdf/layouts/lending.ts` and the first kind/template migration together, then the snapshot builders.


=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======

I stopped partway through C9. Note: your Supabase project `xwxqunklduknceoryrha` is already connected — no new connection was needed.

Done in this turn:
- Verified the real state: lending snapshot builders (`src/services/documents/snapshots/lending.ts`) already exist for all four kinds; `document_template_ast` has 0 rows and, importantly, no `is_active` column in the live DB even though `resolveTemplateAst` filters on it.
- Added `supabase/functions/_shared/pdf/layouts/lending.ts` — four sheet-only generators (`generateLoanAgreementPdf`, `generateRepaymentSchedulePdf`, `generateLoanStatementPdf`, `generateLoanPaymentReceiptPdf`) built purely from the frozen snapshot, with thermal refusal, facts grids, shared schedule table, allocation ladder, summary strip and signature strips.
- Registered a `LENDING_LAYOUTS` map in `supabase/functions/_shared/rendering/renderers/pdf.ts` (before the thermal gate).

Remaining for C9:
1. Finish the pdf.ts wiring: include `LENDING_LAYOUTS` in `hasDedicatedLayout()` and add the dispatch branch in the render function (currently the map is declared but not dispatched, so the fail-closed guard would reject these kinds).
2. Migrations, one object each: four `document_kinds` rows (`lending.loan_agreement`, `lending.repayment_schedule`, `lending.loan_statement`, `lending.payment_receipt`), then the `document_template_ast` migration — which must add the missing `is_active` column before inserting the system-scope default rows, otherwise every render resolves against a column that doesn't exist.
3. Registry entries in `src/services/documents/resolveSourceDocumentRecord.ts` mapping the four legacy doc types to the builders, then wire preview/download/print on the loan and repayment screens.
4. Gate: `tsgo --noEmit` + build, then a live render of each kind.

C10 (bulk ERP removal) and C11 (hardening) are untouched.

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
