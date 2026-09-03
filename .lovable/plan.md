# Smart Grow Empowerment — microfinance platform (plan of record)

Backend: Supabase `Smart Grow Empowerment` (`xwxqunklduknceoryrha`) — already connected. Nothing to reconnect.

One institution. One product: a lending operations system. Not an ERP, not SaaS, no client portal, no payroll/HR, no multi-tenancy.

## Verified state (checked against the codebase, 2026-09-03)

- Apps present: `dashboard`, `lending`, `finance`, `reports`, `studio`, `platform`. No sales / purchasing / inventory / POS / CRM / HR / payroll surfaces remain.
- Lending domain live: clients, groups, products, applications, loans, repayments, collections, documents, reports (`src/apps/lending/*`, `useMf*` hooks, `mf_*` schema).
- Finance retained and reachable: chart of accounts, journal entries, receivables, payables, banking, reconciliation, bank feeds, accounting events, fiscal periods, fixed assets, reversal register, integrity, settings.
- Document engine + report engine inherited and already serving lending docs/reports.
- Gate last run: `tsgo` clean, `build OK`, no unresolved imports.

Conclusion: C1–C10 are genuinely done. Do not re-audit them.

## Reuse (keep, retailor — never rebuild)

Auth/RBAC/PIN sign-in and invitations · app shell, nav registry, design system · document engine (`document_kinds` + template AST + PDF renderer) · report engine (`ReportRegistry` + `design-system/reports`) · Finance: CoA, journals, GL, fiscal periods, fixed assets, banking, bank feeds, reconciliation, **payment settlement engine for receivables/payables**, accounting mapping, audit/reversal infrastructure.

Rule: a working engine is retailored to microfinance vocabulary and data, never deleted and never duplicated inside the lending module.

## Next milestone — C11: retailor retained Finance to microfinance

One pass, in order, no new engines, no speculative refactors.

1. **Settlement + statements** — the receivables/payables settlement engine stays; its microfinance face is loan receivables (portfolio exposure) and institution payables. "Customer statement" becomes **client statement** on the same statement engine, fed by `mf_*` balances.
2. **Vocabulary + surfaces** — finance nav/labels reworded around lending: receivables → loan receivables, banking/reconciliation framed as disbursement and collection accounts (cash, bank, mobile money). Label and data-source changes only.
3. **Mapping-resolved postings** — every `mf_*` event (disbursement, repayment allocation, fee, penalty, write-off, reversal) resolves its accounts through the configured mapping table. Zero account ids in React or in `mf_*` code.
4. **Institution settings** — single-institution identity (name, legal, address, contacts, logo, currency, financial settings) flowing into report and document contexts, not hardcoded.

Gate: `tsgo` clean, `build OK`, `/dashboard`, `/lending/*`, `/finance/*`, `/settings` render, sidebar shows only microfinance surfaces.

## Then — C12: hardening

`mf_*` RLS/grants + linter sweep · RBAC per role (Super Admin, Branch Manager, Loan Officer, Credit Officer, Cashier, Accountant, Collections Officer, Auditor, Reporting) · loan-officer portfolio data scope · audit/immutability proof · live signed-in PDF render of each lending document.

## Known inherited debt (fix only on retained surfaces, during C11/C12)

Legacy SQL-migration guards: `je-description-no-uuid`, `pgcrypto-extension-prefix`, `single-audit-trigger-per-table`, `sql-businesses-currency-column`, `currency-ratchet`. Content-drift guards: banking gating ×2, finance-settings permissions, radix overlay, tanstack-router-in-spa, aged-receivables related-reports. Pre-existing, not caused by the removal sweep.

## Rules (binding)

1. Financial state is derived server-side; React never owns balances, interest, arrears, allocations or journal amounts.
2. Append-only events with mapping-resolved postings; history is never edited.
3. One object per migration; GRANTs + RLS in the same migration.
4. A bug in a removed ERP surface is not a bug.
5. Reuse before rebuild; retailor before delete. Deleting a working engine to rewrite it is a scope violation.
6. No exploratory audits of already-verified milestones. Every action must serve C11 or C12.
7. Each milestone ends with: `tsgo` clean, `build OK`, affected screens rendered, this file updated in place.
