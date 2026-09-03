# Smart Grow Empowerment — microfinance platform (plan of record)

Backend: Supabase `Smart Grow Empowerment` (`xwxqunklduknceoryrha`), already connected. One institution, one product: an internal lending operations system. Staff-only, ASA branch model. No SaaS, no multi-tenancy, no client portal, no payroll/HR/sales/inventory/POS.

## Verified state (re-checked 2026-09-03)

- Apps present and only these: `dashboard`, `lending`, `finance`, `reports`, `studio`, `platform`. No sales / purchasing / inventory / POS / CRM / HR / payroll surfaces remain in the shell.
- Lending domain live under `src/apps/lending/*` (clients, groups, products, applications, loans, repayments, collections, documents, reports) on `mf_*` schema via `useMf*` hooks.
- Finance retained as accounting infrastructure: chart of accounts, journals, GL, fiscal periods, fixed assets, banking, bank feeds, reconciliation, settlement engine, accounting events, reversal register, integrity, settings.
- Reused engines: auth/RBAC/PIN + invitations, app shell + nav registry + design system, document engine (`document_kinds` + template AST + PDF renderer), report engine (`ReportRegistry`, `design-system/reports`).
- Gate: `tsgo --noEmit` clean; `client` added to report scope keys so the client statement report compiles.

Milestones C1–C10 (stack repair, environment isolation, foundation, institution settings, RBAC, finance foundation, ERP removal, client/group/product/application/loan/schedule/disbursement/repayment/collections domain, lending documents, lending reports) are done. Do not re-audit them.

## Current milestone — C11: retailor retained Finance to microfinance

In order, no new engines, no speculative refactors:

1. **Settlement + statements** — DONE for the client-facing surface: `ClientStatementReport` reads the server-owned `mf_client_statement` view. REMAINING: the inherited `customerStatementDataset` / `customerStatementLedger` / `vendorStatementDataset` services still serve the finance receivables/payables statement surfaces on ERP AR/AP subledgers — repoint or retire them.
2. **Vocabulary + surfaces** — DONE. `FINANCE_NAV` reads: loan receivables, institution payables, journal entries, cash & bank accounts, reconciliation, bank feeds, accounting events; Insights and Setup unchanged.
3. **Mapping-resolved postings** — DONE. `mf_post_event` posts every lending event through `mf_resolve_account` + `post_journal_entry_atomic`, keyed on `mf_account_mappings` and idempotent via `mf_event_postings`: disbursement, settlement-by-successor (top-up/restructure), repayment (per allocation component), repayment reversal (mirror of the original lines), write-off. No account ids in React or `mf_*` code. Gap to add when the events exist: fee charged and penalty accrued.
4. **Institution settings** — DONE for documents: the lending snapshot builder injects institution name, legal name, address, phone, email, registration and tax id from `businesses`; the report engine masthead already resolves the same row.

5. **ERP document scaffolding removed (this pass)** — deleted 20 sales/purchases/wms/HR snapshot builders plus their 3 helpers; `resolveSourceDocumentRecord` now registers only `journal_entry` and the four lending kinds (agreement, schedule, statement, payment receipt). Two ERP-only tests deleted. `tsgo` clean; `/dashboard`, `/lending/loans`, `/finance/receivables`, `/finance/reports` all 200.

Gate: `tsgo` clean, `build OK`, `/dashboard`, `/lending/*`, `/finance/*`, `/settings` render, sidebar shows only microfinance surfaces.

## Next — C12: hardening

`mf_*` RLS + GRANTs + Supabase linter sweep · RBAC per role (Super Admin, Branch Manager, Loan Officer, Credit Officer, Cashier, Accountant, Collections Officer, Auditor, Reporting) · loan-officer portfolio data scope · audit/immutability proof · live signed-in PDF render of each lending document.

## Known inherited debt (fix only on retained surfaces, during C11/C12)

Legacy SQL-migration guards: `je-description-no-uuid`, `pgcrypto-extension-prefix`, `single-audit-trigger-per-table`, `sql-businesses-currency-column`, `currency-ratchet`. Content-drift guards: banking gating ×2, finance-settings permissions, radix overlay, tanstack-router-in-spa, aged-receivables related-reports. Pre-existing; not caused by the ERP removal sweep.

## Rules (binding)

1. Financial state is derived server-side; React never owns balances, interest, arrears, allocations or journal amounts.
2. Append-only events with mapping-resolved postings; history is never edited (`UPDATE loans SET ...` is not a business process).
3. One object per migration; GRANTs + RLS in the same migration.
4. A bug in a removed ERP surface is not a bug.
5. Reuse before rebuild; retailor before delete. Deleting a working engine to rewrite it is a scope violation.
6. No exploratory audits of verified milestones. Every action must serve C11 or C12.
7. Each milestone ends with: `tsgo` clean, `build OK`, affected screens rendered, this file updated in place.
