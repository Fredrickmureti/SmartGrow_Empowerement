# Cash & Banking Reporting — Handover Verification (2026-08-20 late) and Next Phases

Legend: **[FACT]** verified this session · **[INFER]** reasoned, not yet proven · **[TASK]** work · **[TEST]** test requirement

History: `.lovable/plan/cash-banking-reporting-*.md`, `.lovable/plan/finance-wave-*-banking-*.md`.

## Phase 1 — Verification of the previous engineer's claims

Spot-checked the load-bearing claims rather than re-reading everything.

- **[FACT]** Phase 6 holds: `src/pages/Banking.tsx` imports `resolveBankAccountBalance` from
  `useBankAccounts` and contains no `useAccountBalances` / `getEffectiveBalance`. No balance
  arithmetic on the page.
- **[FACT]** Phase 2/3 seams exist and are `SECURITY DEFINER` with `search_path=public`:
  `finance_bank_reconciliation_statement(_org_id,_bank_account_id,_as_of,_business_id,_branch_id)`,
  `bank_match_propose/confirm/reject/reverse`.
- **[FACT]** Phase 7's own pending claim is correct: `bank_account_positions(_business_id,_as_of)`
  is **not** SECURITY DEFINER (`prosecdef=false`) and carries no `finance_can_read_org` gate.
- **[FACT]** The report renders the RPC payload; the "Statement does not reconcile" banner is a
  bare statement of the residual with no next action.
- **[INFER]** Phases 0/4/5 were structurally guarded by tests; end-to-end PDF-equals-screen was
  never proved on rendered output (the previous engineer says so themselves). Left as a test task.

### Confirmed defects found during verification (new, not in the old plan)

1. **[FACT] There is no unreconcile path in the product.** `bank_match_reverse` exists in the
   database and in architecture tests, but **no application code calls it** (only
   `propose`/`confirm`/`reject` are used, in `useBankTransactions.ts` and `useBankPendingMatch.ts`).
   A wrongly confirmed match therefore cannot be undone from the UI — the single most important
   gap the user named.
2. **[FACT] The Sessions tab link is context-blind.** `BankReconciliationReport.tsx` links
   `/finance/reconciliation?session=${r.id}`, but `StartReconciliationPage.tsx` reads only
   `searchParams.get("account")`. The `session` parameter is silently dropped: "Open" on a session
   starts an unscoped reconciliation instead of resuming that session.
3. **[FACT] The residual is diagnosed but not actioned.** No candidate explanations
   (duplicate opening-balance posting, cleared-without-posting, unmatched statement lines) are
   surfaced as suggestions, even though the RPC already returns diagnostics
   (`gl_account_missing`, `gl_account_shared`, `cleared_without_posting`,
   `gl_currency_fallback_lines`).

## Live-data finding (carried forward, not an engine defect)

- **[FACT, prior session]** "Joshua Holdings" / "Test Operating Bank – KES": −50,000.00 KES
  residual caused by the opening balance being posted twice (via
  `bank_accounts.opening_balance_je_id` **and** a separate entry behind the 2026-07-31 statement
  line). Must be reversed in data. Phase 10 makes the system *say* this instead of leaving the
  accountant to guess.

## Phased execution plan (in order)

### Phase 7 — Cash position as of a date + position security (next, small)
- **[TASK]** Give the Banking overview an explicit as-of (default today) and pass it into
  `bank_account_positions`, so dashboard and statement cannot drift by date.
- **[TASK]** Prove the RLS reliance of `bank_account_positions` with a foreign-org query. If it
  leaks a single row, bring it onto `finance_can_read_org` as SECURITY DEFINER.
- **[TEST]** Positive + negative SQL leg for `bank_account_positions` in `supabase/tests/`.

### Phase 8 — Unreconcile: expose the reversal seam properly
- **[TASK]** A confirmed match must be reversible from the transaction row and from the session
  view, calling `bank_match_reverse` only — no client writes to `bank_transactions.reconciled`
  or `bank_reconciliation_matches`.
- **[TASK]** Reversal requires a reason, is blocked in a closed session / locked period, and is
  visible in reconciliation history (who, when, why).
- **[TEST]** SQL: reverse unwinds allocations, the settlement journal and the reconciled state;
  reversing twice is refused; reversing inside a completed session is refused.
- **[TEST]** Architecture: no file outside the seam hooks names `bank_match_reverse`.

### Phase 9 — Session-context-aware reconciliation
- **[TASK]** `StartReconciliationPage` reads `?session=`, loads that session, pins its bank
  account, statement period and opening/closing statement balance, and shows a session header with
  live "difference to zero". No silent fallback to an unscoped session.
- **[TASK]** An unknown/foreign/completed session id resolves to an explicit state, not a blank
  new reconciliation.
- **[TEST]** Route-level test for the three cases (valid open, completed, foreign).

### Phase 10 — Residual explainer: tell the accountant what to do next
- **[TASK]** Server-side: extend the statement RPC (or a sibling read model) with ranked
  *candidate causes* for the residual — duplicate opening-balance posting, cleared statement lines
  with no posting, postings on the control account with no statement line, amount-equal
  unmatched pairs, sign-flipped pairs, FX fallback lines.
- **[TASK]** UI: replace the bare banner with ranked suggestions, each with the exact amount and a
  drill-down to the offending rows. Suggestions never mutate anything.
- **[TEST]** The −50,000 opening-balance duplicate must be named by the explainer on live data.

### Phase 11 — Rule engine scrutiny (one rule at a time)
- **[TASK]** Audit `bank_reconciliation_rules` + `apply_reconciliation_rules`: matching precedence,
  overlapping rules, amount tolerance, date window, whether a rule can auto-*confirm* (it must
  only propose), idempotency on re-run, per-rule audit trail and match counts.
- **[TEST]** SQL invariants per behaviour, not one omnibus test.

### Phase 12 — Feed → statement → match → GL chain
- **[TASK]** Prove the chain end-to-end on one account: feed run → `bank_transactions` (fingerprint
  dedupe) → proposal → confirm → journal → session → statement figures, and that reversal walks it
  back. Any step that can be reached another way is a defect to close.

### Phase 13 — Scheduled/branch dimension (deferred, needs a migration)
- **[TASK]** `scheduled_reports` has no `branch_id`; either add it or state the business-wide
  scope on the delivered document.

### Unresolved policy (documented, not blocking)
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.

## Notes for execution
- ~111 pre-existing failing test files elsewhere in the repo (e.g. `wms-rpc-grants`) are unrelated;
  do not fix them here.
- No cosmetic work: each phase changes the authoritative layer first, UI second.
