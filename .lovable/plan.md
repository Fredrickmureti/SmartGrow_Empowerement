# Ledgers & Journals — Verified Status and Next Phases

## Phase 1–5 verification (done this pass, against the live project)

Verified facts (checked in the database and the code, not from the previous notes):

- `public.ledger_visible_journal_statuses()` exists and is referenced by all three
  ledger RPCs (`get_account_movements`, `get_general_ledger`, `get_journal_report`).
  Reversed originals therefore stay visible; reversal pairs are not one-sided.
- All three RPCs are `SECURITY DEFINER`, call `finance_can_read_org(_org_id)`, and
  have `anon` EXECUTE revoked (`authenticated` only). `get_journal_report` also
  validates that `_business_id` belongs to the org and `_branch_id` belongs to the
  org/business before returning rows — tenant scoping is server-side, not client-side.
- Branch scoping is strict (`_branch_id IS NULL OR je.branch_id = _branch_id`); it
  does not absorb unbranched entries into a branch-scoped run.
- `get_journal_report` is entry-paginated with a `total_entries` window count, so the
  old 1000-row client truncation is genuinely gone.
- `reportDataEngine.ts` no longer carries parallel accounting math: `getGLAccountBalances`
  aggregates through `get_account_movements` (prior period + period) and zeroes
  `accounts.opening_balance` on branch-scoped runs; `buildGeneralLedger` and
  `buildJournalReport` read the same RPCs as the screens.
- `render-report` threads `branchId` into trial balance, GL, journal report and cash flow.
- Ledger integrity right now: 13 visible entries / 28 lines, `sum(debit) - sum(credit) = 0`,
  one organization, one branch, one currency.

Verdict: Phase 5 is implemented as claimed. It is **not yet proven numerically**, and the
current dataset (single org, single branch, single currency, 13 entries) cannot exercise
branch scoping, pagination, or FX. That is the gap Phase 5A closes.

## Phase 5A — Prove parity, with tests instead of eyeballing

1. Add `supabase/tests/ledger_reports_engine_test.sql` covering, on purpose-built fixture data:
   - trial balance identity: total debits = total credits over a period;
   - opening + movement = closing per account, derived independently from
     `journal_entry_lines` and compared to `get_account_movements`;
   - a reversal pair: both original and reversing entry appear in GL and Journal Report,
     and net to zero in the period;
   - branch scoping: an unbranched entry must NOT appear in a branch-scoped run;
   - cross-org isolation: an org-B entry never appears in an org-A call;
   - pagination completeness: `get_journal_report` paged at a small limit returns every
     entry exactly once, and `total_entries` matches.
2. Add `src/test/architecture/ledger-reports-single-source.test.ts`: the ledger screens and
   `reportDataEngine` may only reach ledger data through the three RPCs — no direct
   `journal_entries` / `journal_entry_lines` selects for reporting.
3. Screen-vs-PDF parity: render Trial Balance, General Ledger and Journal Report through
   `render-report` in `json` mode with and without `branchId`, and assert the totals equal
   the RPC-derived totals. This runs as a test, not a manual comparison.

Exit condition: all of the above green. Only then start Phase 6.

## Phase 6 — Multi-currency presentation

Accounting rule being applied: `journal_entry_lines.debit/credit` are BASE currency;
`original_debit/original_credit` plus `exchange_rate` carry the document currency. Ledger
reports must never re-derive FX.

- Trial Balance: base currency only. State the base currency in the masthead. No
  original-currency columns — a trial balance in mixed units does not balance.
- General Ledger: base-currency debit/credit/running balance as the authoritative columns,
  with original amount + currency + rate shown as supplementary columns, rendered only when
  the account actually has foreign-currency movement (the screen already detects this).
- Journal Report: same treatment at line level; entry currency shown on the entry header.
- `get_general_ledger` / `get_journal_report` must return `original_debit`, `original_credit`
  and `exchange_rate`; `columnSpecs.ts` gains the matching optional columns so the PDF is the
  same document as the screen.
- Masthead on all three states base currency explicitly.

## Phase 7 — Gaps found during verification (added to the plan)

- **Drill-down**: GL and Journal Report expose `source_type` / `source_id` but the path back
  to the source document is not uniformly wired. One shared resolver, used by both screens.
- **Locked periods / fiscal-year boundary**: no test asserts a period-locked or year-boundary
  run behaves correctly. Add to the Phase 5A SQL suite.
- **Zero-balance and inactive accounts**: confirm and pin the intended behaviour (trial balance
  includes accounts with activity or a non-zero opening; GL honours `_include_zero_activity`).
- **Draft entries**: confirmed excluded by `ledger_visible_journal_statuses()`. Correct, and
  must stay that way — add it as an assertion so it cannot regress silently.

## Scope boundaries

- No new reporting engine, no new report screens, no UI redesign.
- Do not change the posting engine or ADR-0123's posting monopoly.
- Partner Ledger, Consolidation and Control Account Reconciliation are out of scope this wave.
