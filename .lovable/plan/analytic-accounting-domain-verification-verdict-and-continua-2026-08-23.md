# Analytic Accounting Domain — Verification Verdict and Continuation

Roadmap and original findings: `.lovable/plan/analytic-accounting-domain-forensic-assessment-2026-08-23.md`.
Last updated: 2026-08-23 (handover verification).

## Phase 1 — Verification of the previous engineer's claims

Every claim was checked directly against the live database and the code. Verdict per claim:

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 0 — RLS business-scoped and role-gated on `analytic_plans` / `analytic_accounts` / `analytic_groups` | Confirmed | RLS enabled on all three; SELECT gated by `user_can_access_business` + `user_has_module_permission(...,'financials','read')`; INSERT/UPDATE/DELETE gated by `has_finance_permission(...,'finance.manage_coa')`. No org-only policies remain. |
| Phase 1 — fabricated `balance` column removed | Confirmed | No `balance` column on `analytic_accounts`; no balance column in `src/pages/AnalyticAccounts.tsx`. |
| Phase 2 — `analytic_plans` + `plan_id` + `status` lifecycle | Confirmed | 4 plans seeded; `analytic_accounts` has `plan_id` and `status`; `analytic_type` enum gone. |
| Phase 3 — attribution at posting via `journal_entry_line_analytics` (JELA) | Confirmed structurally | Trigger `trg_jel_sync_analytics` installed on `journal_entry_lines`; `_jel_sync_analytics` rejects foreign-business accounts (23514), rejects non-`active` accounts, skips zero-value lines, writes signed `amount` + `percentage = 100`, stamps `entry_date` from the header. |
| `analytic_distributions` is a read-only view | Confirmed | `information_schema.tables.table_type = VIEW`. |
| `analytic_balances` server-side aggregation | Confirmed | SECURITY DEFINER, pinned `search_path`, authorizes with `user_can_access_business` **and** `user_has_module_permission`, excludes `journal_entries.status = 'void'`. |
| JELA is client-immutable | Confirmed (newly checked) | RLS on, and the only policy is `jela_select`. No client INSERT/UPDATE/DELETE path exists; only the definer trigger writes. |
| Phase 4 — producers | Confirmed **not started** | `src/features/finance/journal-entries/JournalEntryForm.tsx` contains no analytic field; no `analytic_account_id` on `bill_items` / `invoice_items` (the only analytic columns in the whole schema are on `expenses`, `purchase_requisitions`, `journal_entry_lines`, JELA, and the view). |
| Phase 5 — consumers | Confirmed not started | `ReportRegistry.ts` / `reportsNav.ts` contain no analytic report; the only "analytics" hits are HR/BI keywords. |

Live data state: `analytic_accounts` = 0, JELA = 0. Phase 3 therefore remains **unproven end to end** — nothing has ever posted through it.

## Newly identified gaps (added to the plan)

1. **Analytic history is destroyed on line update.** `_jel_sync_analytics` does `DELETE FROM journal_entry_line_analytics WHERE journal_entry_line_id = NEW.id` on every `UPDATE` of `journal_entry_lines`. That is correct only while an entry is unposted. On a posted entry it silently rewrites analytic history with no audit trail — the same defect class the domain was cleaned up to remove. Must be constrained to non-posted entries and refuse otherwise.
2. **Two parallel attribution ledgers.** `LineAnalyticsCell` / `ProjectPicker` tag document lines with `project_id` / `task_id` feeding `project_cost_entries`, while GL attribution lives in JELA. Project profitability and analytic reporting will disagree.
3. **Dead column.** `projects.analytic_account_code` is a text code with no FK and no reader — remove or bind it to `analytic_accounts.id`.
4. **Header-level analytic side columns.** `expenses.analytic_account_id` and `purchase_requisitions.analytic_account_id` are document-header fields; the expense posting path must be re-proven to carry them onto the GL line so JELA is the only store.
5. **`ExpenseFormFields.tsx:169`** still lists `activeAccounts` unfiltered by plan (carried over from the previous engineer's own open list).

## Work plan

### Phase 3b — Prove the engine (blocking)
Post a real expense with an analytic account in a test business, then void it. Required outcome: one JELA row on post, a contra row on void, zero deletes, `analytic_balances` nets to zero, JELA sums tie to the GL line amounts. Add the trigger guard from gap 1 (reject analytic rewrites on posted entries; allow on draft) and fix gap 5.

### Phase 4 — Producers (in order, each finished completely)
1. **Manual journal entry** — per-line analytic picker in `JournalEntryForm.tsx`, restricted to postable (`active`) accounts of the selected plan, flowing through the existing `_lines` payload of `post_journal_entry_atomic` (which already accepts `analytic_account_id`). Includes edit, void and reversal behaviour plus permission gating.
2. **Bills** — line-level analytic on bill items, carried into the bill posting line builder.
3. **Invoices** — same for invoice lines and their COGS counterpart.
4. **Project ledger reconciliation** — make project/task tagging resolve to an analytic account on the GL line so `project_cost_entries` stops being a second truth; retire or repoint gaps 2–4.

### Phase 5 — Consumers (exactly three reports, server-side)
Analytic Account Statement (drill-down to the journal entry), P&L by Analytic Account, Budget vs Actual by Analytic Account — all through `reportDataEngine` + `ReportRegistry`, period- and branch-aware, each tying out to the GL. No client-side aggregation.

### Phase 6 — Guards
SQL tests: GL tie-out, 100% allocation per line/plan, cross-business isolation, posted-entry analytic immutability. Architecture test forbidding client-side analytic aggregation and direct JELA writes.

## Explicitly out of scope
User-defined unlimited dimensions, a separate analytic budget engine, stored analytic balances, statistical postings without a GL counterpart, automatic distribution-rule engines.

## Technical notes
- One posting engine only: `post_journal_entry_atomic` (ADR 0123). Producers build lines; they never insert journal rows.
- JELA stays definer-trigger-written and client-read-only. Reversal must produce contra rows, never deletes.
- All new reads go through SECURITY DEFINER functions with pinned `search_path` that authorize with `user_can_access_business` + `user_has_module_permission`.
