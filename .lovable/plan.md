# Analytic Accounting Domain — Authoritative Project Status

Source of truth for this domain. Forensic findings and roadmap:
`.lovable/plan/analytic-accounting-domain-verification-verdict-and-continua-2026-08-23.md`.

Last updated: 2026-08-23. Active phase: **Phase 4 — Producers (project ledger reconciliation remaining)**.

## Status at a glance

| Phase | Scope | State |
|---|---|---|
| 0 | Security & integrity (business-scoped RLS, role-gated writes, delete guards) | Done, verified |
| 1 | Truthful UI (fabricated balance removed) | Done, verified |
| 2 | Model correction (`analytic_plans`, status lifecycle, immutability guards) | Done, verified |
| 3 | Attribution at posting (JELA, view over it, reversal path) | Done |
| 3b | Engine hardening (trigger cannot destroy posted history; balances exclude drafts/voided) | Done |
| 4 | Producers: Manual JE, Expenses, Bills, Invoices | Done — **project ledger reconciliation still open** |
| 5 | Consumers (3 server-side analytic reports) | Not started |
| 6 | Guards (SQL contract test, architecture test) | SQL contract test in place; architecture test pending |

## What is now live

- **Engine.** `journal_entry_line_analytics` is written only by `trg_jel_sync_analytics`
  on `journal_entry_lines` (INSERT and UPDATE), so posting and reversal share one
  path. `analytic_distributions` is a view over it. `analytic_balances` counts
  `posted`/`reversed` entries only (the earlier `'void'` vs `'voided'` typo is fixed)
  and accepts an optional branch filter. Updates to posted/voided lines are rejected,
  so attribution history cannot be destroyed.
- **Producers.** Analytic account selection exists and reaches the GL line for:
  Manual Journal Entries (`JournalEntryForm` / `JournalLineRow` → `post_journal_entry_atomic`),
  Expenses (plan-filtered to cost-centre/department), Bills (`bill_items.analytic_account_id`,
  grouped by GL + analytic account in `confirm_bill_atomic`), and Invoices
  (`invoice_items.analytic_account_id`, grouped in `build_invoice_je_lines`;
  persisted by `create_invoice_atomic` and the edit path).
- **Guard trigger.** `_assert_document_line_analytic_account` rejects analytic
  accounts that are not postable or belong to another company.
- **Contract test.** `supabase/tests/analytic_accounting_contract_test.sql` asserts:
  JELA has no client write policy; the trigger fires on insert and update;
  `analytic_distributions` is a view; `analytic_balances` excludes drafts/voided;
  JELA nets to the signed GL line amount; no analytic row crosses a company.
  All assertions pass against live state (0 attributed lines so far, so tie-out is
  vacuous until real postings exist).

## Still pending

1. **Phase 4 remainder — project ledger reconciliation.** `project_cost_entries` /
   `LineAnalyticsCell` remain a parallel attribution path. Decide and implement:
   project attribution should land in the GL analytic ledger (a `project` analytic
   plan) with `project_cost_entries` derived from it, not maintained alongside it.
2. **Phase 5 — Consumers.** Exactly three reports through `reportDataEngine` +
   `ReportRegistry`: Analytic Account Statement (drill to JE), P&L by Analytic
   Account, Budget vs Actual by Analytic Account. Server-side, period- and
   branch-aware, each tying out to the GL.
3. **Phase 6 remainder — architecture test** forbidding client-side analytic
   aggregation, plus a live post/void round trip once real analytic postings exist
   (expect one JELA row on post, a contra row on void, net zero, no deletes).

Explicitly out of scope (do not build): user-defined unlimited dimensions, a separate
analytic budget engine, stored analytic balances, statistical postings without a GL
counterpart, automatic distribution-rule engines.

## Instructions for the next agent

1. Verify, don't trust: re-run `supabase/tests/analytic_accounting_contract_test.sql`
   before changing anything.
2. Finish the project-ledger reconciliation before starting reports — reports over an
   empty or split ledger are the original defect of this domain.
3. Keep aggregation server-side. The client selects an axis; the database computes amounts.
4. Update this file at the end of your work so it stays authoritative.
