# Smart Grow Empowerment — microfinance platform (plan of record)

Backend: Supabase `Smart Grow Empowerment` (`xwxqunklduknceoryrha`) — already connected. Nothing to reconnect.

Scope rule: this is a single-institution microfinance system, not an ERP and not SaaS.
Everything below is judged by one question — does the microfinance business need it?

## Reused foundations (keep, retailor — never rebuild)

- Auth / RBAC / PIN sign-in, invitations, roles, branch scope.
- App shell, navigation registry, design system, tables/forms/filters/overlays.
- Document engine (`document_kinds` + template AST + edge PDF renderer) — lending docs already registered.
- Report engine (`ReportRegistry` + `design-system/reports` + server column specs) — lending reports already registered.
- Finance: Chart of Accounts, journals, fiscal periods, GL, fixed assets, banking, bank feeds, reconciliation, receivables/payables settlement engine, accounting mapping. Retailored to microfinance vocabulary, not deleted.

## Removed (ERP, out of scope)

Sales/order-to-cash, purchasing/procurement, inventory, warehouse, POS, CRM, HR/employee directory, payroll, attendance, projects, budgets, consolidation, analytic accounting, tax/statutory filing, BI, migration wizard, ERP contacts app, customer statements/credits, receipt-theme engine, and the edge functions serving them (`mpesa-*` kept).

## Milestone status

- C1–C8b — microfinance domain foundation (`mf_*` schema, clients, groups, products, applications, approval, loans, schedule engine, disbursement, repayments/allocation, arrears): DONE, V1 live lifecycle proof PASS.
- C9 reports — DONE (portfolio, arrears, collections, disbursements on the inherited engine).
- C9 documents — DONE (loan agreement, repayment schedule, loan statement, payment receipt on the inherited document engine).
- **C10 ERP removal sweep — DONE (2026-09-03).**
  - App/route/nav registries reduced to Dashboard / Lending / Finance / Reports / Studio / Settings.
  - 526 unreachable ERP modules deleted (reachability scan from `main/App/router/routes`), plus 44 obsolete ERP guard tests and the report-nav families for removed reports (partner ledger, budgets, tax, consolidation, analytic accounting, BI).
  - Verification: `tsgo --noEmit` clean, `build OK`, zero unresolved imports across `src` (import-resolution scan).
  - Known inherited debt (pre-existing, not caused by the sweep — legacy SQL migration guards): `je-description-no-uuid`, `pgcrypto-extension-prefix`, `single-audit-trigger-per-table`, `sql-businesses-currency-column`, `currency-ratchet`, plus content-drift guards `banking-business-level-gating`, `bank-feeds-business-level-gating`, `finance-settings-permission-gated`, `no-conditional-radix-overlay`, `no-tanstack-router-in-spa`. Address in C11/C12 only where the surface is retained.

## Next — C11: retailor retained Finance to microfinance

One pass, in this order, no new engines:

1. **Vocabulary + surfaces**: receivables → loan receivables/portfolio exposure; payables → institution payables; "customer statement" → **client statement** built on the retained statement engine; banking/reconciliation labelled around disbursement and collection accounts (cash, bank, mobile money).
2. **Accounting mapping**: ensure every `mf_*` event (disbursement, repayment allocation, fee, penalty, write-off, reversal) resolves accounts through the configured mapping table — no account ids in React or in `mf_*` code.
3. **Institution settings**: single-institution identity (name, legal, address, contacts, logo, currency, financial settings) flowing into report and document contexts.
4. Gate: `tsgo` clean, `build OK`, `/dashboard`, `/lending/*`, `/finance/*`, `/settings` render, sidebar shows only the microfinance surfaces.

Then **C12 hardening**: `mf_*` RLS/grants + linter sweep, RBAC enforcement per role (Super Admin, Branch Manager, Loan Officer, Credit Officer, Cashier, Accountant, Collections Officer, Auditor, Reporting), loan-officer portfolio data scope, audit/immutability proof, live PDF render of each lending document from a signed-in session.

## Rules (binding)

1. Financial state is derived server-side; React never owns balances, interest, arrears, allocations or journal amounts.
2. Append-only events with mapping-resolved postings; history is never edited.
3. One object per migration; GRANTs + RLS in the same migration.
4. A bug in a removed ERP surface is not a bug.
5. Reuse before rebuild — retailor working Finance/banking/settlement/document/report engines.
6. No client portal, no multi-tenancy, no payroll/HR product, no speculative abstractions.
7. Each milestone ends with: tsgo clean, build OK, affected screens rendered, this file updated in place.
