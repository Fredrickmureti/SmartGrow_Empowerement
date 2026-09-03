# Smart Grow Empowerment — microfinance platform (plan of record)

One institution, staff-only lending operations. Backend: Supabase `xwxqunklduknceoryrha`.
No SaaS, no multi-tenancy, no client portal, no payroll/HR/sales/inventory/POS/CRM.

## Scope contract (binding)

- Reuse, tailored to microfinance: auth/RBAC/PIN + invitations, app shell + nav + design system,
  document engine (kinds + template AST + PDF renderer), report engine, and the Finance core
  (chart of accounts, journals/GL, fiscal periods, fixed assets, banking, bank feeds,
  reconciliation, settlement engine, accounting events, reversal register).
- Remove/leave out: everything else inherited from the ERP.
- Financial state is derived server-side; React never owns balances, interest, arrears,
  allocations or journal amounts.
- Append-only business events with mapping-resolved postings. `UPDATE loans SET ...` is not a
  business process.
- One object per migration; GRANTs + RLS in the same migration.
- A bug in a removed ERP surface is not a bug. No re-auditing verified milestones.
- Each milestone ends with: `tsgo` clean, build OK, affected screens rendered, this file updated.

## Verified state (2026-09-03, re-checked against the codebase)

- Shell contains only `dashboard`, `lending`, `finance`, `reports`, `studio`, `platform`.
- Lending domain live under `src/apps/lending/*` (clients, groups, products, applications, loans,
  repayments, collections, documents, reports, settings) on the `mf_*` schema via `useMf*` hooks.
- Finance retained as accounting infrastructure with microfinance vocabulary in `FINANCE_NAV`
  (loan receivables, institution payables, journal entries, cash & bank, reconciliation,
  bank feeds, accounting events).
- `mf_post_event` posts disbursement, settlement-by-successor (top-up/restructure), repayment
  per allocation component, repayment reversal, and write-off through `mf_resolve_account` +
  `post_journal_entry_atomic`, idempotent via `mf_event_postings`. No account ids in app code.
- Documents: only `journal_entry` + the four lending kinds are registered; institution identity
  (name, legal name, address, phone, email, registration, tax id) is injected from `businesses`.
- Client statement reads the server-owned `mf_client_statement` view.
- **Closed this pass:** the inherited `customerStatementDataset/Ledger` and
  `vendorStatementDataset/Ledger` services were verified unreferenced and deleted. `tsgo` clean.

Milestones C1–C11 are complete. Do not re-open them.

## C12 — hardening (current milestone, in order)

1. `mf_*` data security: RLS policies + GRANTs on every `mf_*` table, then a Supabase linter
   sweep; fix only findings on retained surfaces.
2. RBAC roles wired end to end: Super Admin, Branch Manager, Loan Officer, Credit Officer,
   Cashier, Accountant, Collections Officer, Auditor, Reporting User — server-side enforcement
   is authoritative, nav hiding is cosmetic.
3. Loan-officer / branch data scope: a loan officer sees only their portfolio's clients, loans,
   repayments and collections.
4. Audit + immutability proof: every lending business event attributable to a user; reversals,
   not edits; no destructive deletion of financial history.
5. Live signed-in render of each lending document (agreement, schedule, statement, receipt) and
   each lending report through the retained engines.

Exit gate: linter clean on `mf_*`, role matrix demonstrated, portfolio scoping demonstrated,
four PDFs rendered signed-in, `tsgo` clean, build OK.

## C13 — remaining lending gaps (only after C12)

- Fee-charged and penalty-accrued events + their mappings in `mf_post_event`.
- Configurable repayment allocation order (policy-driven, not hardcoded).
- Arrears/PAR derivation verified against schedule-vs-payments on real data.

## Known inherited debt (fix only when it blocks a retained surface)

Legacy SQL-migration guards (`je-description-no-uuid`, `pgcrypto-extension-prefix`,
`single-audit-trigger-per-table`, `sql-businesses-currency-column`, `currency-ratchet`) and
content-drift guards (banking gating ×2, finance-settings permissions, radix overlay,
tanstack-router-in-spa, aged-receivables related-reports). Pre-existing.
