# Analytic Accounting Domain — Authoritative Project Status

Source of truth for this domain. Roadmap and findings: `.lovable/plan/analytic-accounting-domain-forensic-assessment-2026-08-23.md`.

Last updated: 2026-08-23. Active phase: **Phase 4 — Producers** (not started).

## Status at a glance

| Phase | Scope | State |
|---|---|---|
| 0 | Security & integrity (business-scoped RLS, role-aware writes, delete guards) | Done, verified |
| 1 | Truthful UI (remove fabricated balance) | Done, verified |
| 2 | Model correction (`analytic_plans`, status lifecycle, immutability guards) | Done, verified |
| 3 | Attribution at posting (`journal_entry_line_analytics`, derived view, reversal) | Done, verified structurally — **not yet exercised with live postings** |
| 4 | Producers (Manual JE, Bills, Invoices, reconcile project cost ledger) | **Next — not started** |
| 5 | Consumers (3 server-side analytic reports) | Not started |
| 6 | Guards (SQL tie-out tests, architecture test) | Not started |

## Fully implemented and verified

**Phase 0 — Security & integrity**
- RLS on `analytic_plans`, `analytic_accounts`, `analytic_groups` rewritten to be business-scoped via `user_can_access_business`, with role-gated writes. Org-only policies removed.
- Uniqueness moved to business grain; hard delete of a referenced account blocked by trigger (archive instead). Distribution cascade removed.

**Phase 1 — Truthful UI**
- `analytic_accounts.balance` column dropped; the fabricated balance column removed from `src/pages/AnalyticAccounts.tsx`. No number is shown that the system does not compute.

**Phase 2 — Model correction**
- `analytic_plans` created and seeded (4 plans per business; live count = 4). `analytic_accounts` gained `plan_id`, `status` (draft/active/restricted/archived), parent; the `analytic_type` enum was dropped.
- Triggers prevent changing plan/business once an account has posted history.
- UI aligned: `src/hooks/useAnalyticAccounts.ts`, `AnalyticAccountSheet.tsx`, `AnalyticAccounts.tsx` (plan filter, status badge, archive action), `RequisitionCreatePage.tsx` (postable accounts only).

**Phase 3 — Attribution at posting**
- `journal_entry_line_analytics` (JELA) holds signed allocations keyed to the GL line. Trigger `trg_jel_sync_analytics` on `journal_entry_lines` materialises the 100% allocation whenever a line carries an analytic account, so posting *and* void/reversal (which mirrors lines) flow through one path — reversal produces contra rows, never deletes.
- `post_expense_gl` / `expense_void` no longer side-write or delete `analytic_distributions`.
- `analytic_distributions` is now a **read-only view** over JELA (verified: `table_type = VIEW`), so the side table can no longer drift from the ledger.
- `public.analytic_balances(business, from, to, plan)` computes net amounts server-side; internal helpers had public execute revoked.

## Verified live state (2026-08-23)

`analytic_plans` = 4 rows; `analytic_accounts` = 0; `journal_entry_line_analytics` = 0; `analytic_distributions` = VIEW; `analytic_balances` exists; `trg_jel_sync_analytics` installed.

Implication: the engine is in place but **no real data has flowed through it yet**. Phase 3 is structurally complete and untested end to end.

## Still pending

- **Phase 4 — Producers.** Manual JE line analytic picker (RPC already accepts `analytic_account_id`); then Bills lines; then Invoices. Reconcile `LineAnalyticsCell` / `project_cost_entries` so project attribution lands in the same ledger instead of a parallel one.
- **Phase 5 — Consumers.** Exactly three reports through `reportDataEngine` + `ReportRegistry`: Analytic Account Statement (drill to JE), P&L by Analytic Account, Budget vs Actual by Analytic Account. Server-side, period- and branch-aware, each tying out to the GL.
- **Phase 6 — Guards.** SQL tests for GL tie-out, 100% allocation per line/plan, cross-business isolation; architecture test forbidding client-side analytic aggregation.
- **Known open UI item inside Phase 4:** `src/features/purchases/expenses/ExpenseFormFields.tsx:169` still uses `activeAccounts` without filtering by plan — align it with the cost-center plan the same way `RequisitionCreatePage.tsx` does.

Explicitly out of scope (do not build): user-defined unlimited dimensions, a separate analytic budget engine, stored analytic balances, statistical postings without a GL counterpart, automatic distribution-rule engines.

## Instructions for the next agent

1. **Verify before you build.** Do not trust this document. Confirm, with queries and file reads:
   - RLS on all analytic tables is business-scoped and role-gated, and an org member of another business cannot read rows.
   - `analytic_distributions` is still a view and there is no remaining write path to it.
   - Post a real expense with an analytic account against a test business, then void it. Expect: one JELA row on post, a contra row on void, and no deletes. `analytic_balances` must net to zero after the void, and JELA sums must tie out to the GL line amounts.
   - `trg_jel_sync_analytics` fires on insert **and** update of `journal_entry_lines.analytic_account_id`, and rejects archived/restricted accounts for new postings.
2. **Fix any gap found before moving on.** Phase 3 does not count as closed until the post/void round trip above is demonstrated.
3. **Then resume at Phase 4**, in this order: Manual JE → Bills → Invoices → project ledger reconciliation. Finish each producer completely (UI field, server write through the GL line, reversal behaviour, permission checks) before starting the next.
4. **Do not** jump to reporting (Phase 5) before at least one producer beyond Expenses is live — reports with no data are the defect this domain already suffered from.
5. Keep execution chronological. No partial producers, no orphaned UI fields, no client-side aggregation. Update this file at the end of your work so it stays authoritative.
