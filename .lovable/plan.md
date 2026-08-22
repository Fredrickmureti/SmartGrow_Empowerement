# Ledgers & Journals — Authoritative Status

Active phase: **Phase 5 (server/PDF engine unification) — implemented, pending live verification**
Next phase: **Phase 6 (multi-currency presentation)**

## Completed and verified

### Phase 1 — Ledger visibility contract
- `public.ledger_visible_journal_statuses()` is the single source of which statuses appear in a ledger (`posted`, `reversed`).
- `get_account_movements` and `get_general_ledger` use it, so a reversed original no longer vanishes and leaves a one-sided reversal.
- Reversal lineage repaired: `reversed_by_id` backfilled, `trg_sync_journal_reversal_backpointer` keeps both pointers consistent, immutability trigger has a scoped `lineage_repair` hatch.

### Phase 2 — Trial Balance period logic
- Hardcoded `1970-01-01` removed; the report runs over a real reporting period (defaults to start of current year).
- Opening / movement / closing are now three distinct, meaningful columns.
- `useFinancialReport` scopes accounts with strict business equality and ignores `accounts.opening_balance` when a branch filter is active (it is a business-level property).

### Phase 3 — General Ledger dimensions
- `get_general_ledger` returns entry status, reversal flags, journal book, branch name, entry currency; opening balance is branch-correct.
- Screen shows Journal / Branch / Status / Currency, hiding columns with no distinct information.

### Phase 4 — Posting Journal
- New paginated `get_journal_report` RPC (strict branch equality) replaces the client fetch that silently truncated at 1000 rows.
- Screen is entry-grouped with per-entry subtotals, a period balance proof, and pagination.
- `PUBLIC`/`anon` execute revoked on the new RPCs; access gated by `finance_can_read_org`.

## Phase 5 — Server/PDF engine unification (implemented this pass)

`supabase/functions/_shared/reportDataEngine.ts` no longer carries parallel accounting math:
- `getGLAccountBalances` aggregates through the `get_account_movements` RPC (prior period + period), accepts `branchId`, and zeroes `accounts.opening_balance` on branch-scoped runs. Removes the 1000-row cap and the `posted`-only filter.
- `buildGeneralLedger` is built from `get_general_ledger` — same rows as the screen, with journal/status columns and reversal markers.
- `buildJournalReport` is built from `get_journal_report`, pages through all entries, and emits the entry-grouped document (header, lines, entry total, grand total).
- `buildTrialBalance` / `buildGeneralLedger` / `buildJournalReport` accept `branchId`; `render-report`'s `buildReportData` threads it. Scheduled reports intentionally pass no branch (a schedule has no branch dimension).
- `columnSpecs.ts` updated for both documents (GL gains Journal/Status; Journal Report becomes account/description/source/debit/credit).

Pending verification for Phase 5:
1. Render each of Trial Balance, General Ledger, Journal Report to PDF and JSON via `render-report`, with and without `branchId`, and compare totals against the screen.
2. Confirm a period containing a reversal pair prints both entries in the PDF.
3. Confirm a >1000-line period is complete in the PDF (no truncation).

## Phase 6 — Multi-currency presentation (not started)
- Show entry currency vs base currency on ledger documents; state the base currency in the masthead; decide the presentation rule for foreign-currency entries in TB (base only) and GL/JR (both).

## Instructions for the next agent

1. **Verify before extending.** Run the Phase 5 verification list above against the live project. Check RPC parity numerically (screen JSON vs `render-report` JSON) rather than by inspection. Check that `get_account_movements` with `_date_from = 1900-01-01` returns the same prior-period totals the screen computes.
2. Only after Phase 5 verifies clean, start Phase 6.
3. Do not open unrelated domains, and do not leave a phase partially wired — each phase must be coherent on screen, in PDF, and in scheduled runs before the next begins.
