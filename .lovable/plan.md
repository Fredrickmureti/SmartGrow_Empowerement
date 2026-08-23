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

## Still pending (in execution order)

1. **NEXT TASK — Phase 4 remainder: project ledger reconciliation.**
   `project_cost_entries` / `src/components/projects/LineAnalyticsCell.tsx` remain a
   parallel attribution path alongside the GL analytic ledger. Bring Phase 4 to a
   coherent close: project attribution lands in the GL analytic ledger (a `project`
   analytic plan, one account per project) and `project_cost_entries` becomes derived
   from it — never maintained independently. Includes: migration for the plan/account
   provisioning and the derivation, the write path through `journal_entry_lines`,
   reversal behaviour, permission checks, and pointing the Projects UI at the same
   picker used elsewhere (`src/components/finance/AnalyticAccountCell.tsx`).
   Phase 4 is not closed until no code writes project cost attribution outside the GL.
2. **Phase 5 — Consumers.** Exactly three reports through `reportDataEngine` +
   `ReportRegistry`: Analytic Account Statement (drill to JE), P&L by Analytic
   Account, Budget vs Actual by Analytic Account. Server-side, period- and
   branch-aware, each tying out to the GL. Do not start before item 1 is closed.
3. **Phase 6 remainder — architecture test** forbidding client-side analytic
   aggregation, plus a live post/void round trip once real analytic postings exist
   (expect one JELA row on post, a contra row on void, net zero, no deletes).

Explicitly out of scope (do not build): user-defined unlimited dimensions, a separate
analytic budget engine, stored analytic balances, statistical postings without a GL
counterpart, automatic distribution-rule engines.

## Instructions for the next agent

**Step 1 — Verify before building. Trust nothing in this document.**

- Run `supabase/tests/analytic_accounting_contract_test.sql` and confirm every
  assertion passes.
- Confirm each Phase 4 producer really reaches the ledger, by reading the code path
  end to end (UI field → client hook → RPC → `journal_entry_lines.analytic_account_id`)
  for Manual JE, Expenses, Bills and Invoices. Check the edit/update paths too, not
  only creation: a producer that loses the analytic account on edit is not done.
- Confirm the analytic pickers are plan-filtered and exclude archived/restricted
  accounts, and that `_assert_document_line_analytic_account` still guards both
  `bill_items` and `invoice_items`.
- Exercise one real round trip if a test business is available: post a document with
  an analytic account, then void it. Expect a JELA row on post, a contra row on void,
  `analytic_balances` netting to zero, and no deleted history.

**Step 2 — Fix any gap found before moving forward.** A phase marked Done that fails
verification is reopened; do not layer new work on top of it.

**Step 3 — Resume chronologically at the NEXT TASK above** (project ledger
reconciliation), then Phase 5, then Phase 6. Do not start reports before the ledger is
single-sourced, and do not pick up unrelated work in other domains.

**Standing rules.** Aggregation stays server-side — the client selects an axis, the
database computes amounts. No orphaned UI fields, no half-wired producers, no second
book of record. Update this file at the end of your work so it stays authoritative.

