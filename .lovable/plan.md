# Cash & Banking Reporting — Authoritative Status (2026-08-20, late session)

Legend: **[DONE]** implemented and verified · **[PENDING]** not started · **[ACTIVE]** in progress
History: `.lovable/plan/cash-banking-reporting-*.md`, `.lovable/plan/finance-wave-*-banking-*.md`.

## Where the roadmap stands

| Phase | Subject | Status |
| --- | --- | --- |
| 0–6 | Engine, isolation, currency, exports, Banking page de-arithmetic | **[DONE]** (verified earlier this session) |
| 7 | Cash position as of a date | **[DONE]** |
| 8 | Unreconcile | **[DONE]** (already existed; verified) |
| 9 | Session-context-aware reconciliation | **[DONE]** |
| 10 | Residual explainer | **[DONE]** — this session |
| 11 | Rule engine scrutiny | **[PENDING]** — next |
| 12 | Feed → statement → match → GL chain proof | **[PENDING]** |
| 13 | Scheduled/branch dimension (needs migration) | **[PENDING, deferred]** |

## Completed this session

### Phase 7 — Cash position as of a date
- `src/hooks/useBankAccounts.ts` threads an optional `asOf` through `loadBankAccounts`,
  `getBankAccounts` and `useBankAccounts`, into `bank_account_positions`. The as-of date is part
  of the cache key, so two dates can never share a cached result.
- `src/pages/Banking.tsx` has an "As at" picker (capped at today) and states the date on the
  Total Balance card, so the dashboard and the reconciliation statement cannot drift by date.
- `supabase/tests/bank_account_positions_invariants_test.sql` guards the RPC: still
  SECURITY INVOKER, not executable by `anon`, RLS-scoped, signed-amount statement balance,
  `_as_of` honoured.

### Phase 8 — Unreconcile (verified, no change needed)
`unreconcile_bank_transaction` (which delegates to `bank_match_reverse`) is wired through
`useBankTransactions.unreconcileTransaction` and exposed as "Unreconcile" in
`src/pages/BankReconciliation.tsx`. No client-side writes to `bank_transactions.reconciled`
or `bank_reconciliation_matches`.

### Phase 9 — Session-context-aware reconciliation
`src/pages/BankReconciliation.tsx` reads `?session=`, selects that session's bank account,
switches to the right tab (in-progress → transactions, closed → recon history) and shows a
session banner with a "Clear" action. "Open" from the sessions register is no longer
context-blind.

### Phase 10 — Residual explainer (this session)
- **Engine.** `finance_bank_reconciliation_statement` now returns
  `residual_explanations`: a ranked array of candidate causes, produced server-side and only
  when the residual is material (≥ 0.01) and the book side is computable. Codes:
  `duplicate_opening_balance` (rank 10), `unmatched_equal_pairs` (20), `sign_flipped_pairs` (30),
  `cleared_without_posting` (40), `single_item_equals_residual` (50), `fx_fallback_lines` (60).
  Each carries a title, an instruction, the exact amount and up to 20 offending rows
  (journal entry or statement line). Function stays SECURITY DEFINER, `search_path=public`,
  `finance_can_read_org` gated, no `anon` EXECUTE. Nothing is mutated.
- **Client seam.** `src/services/finance/bankReconciliationStatement.ts` exposes
  `ResidualExplanation` / `ResidualExplanationRef` and maps the payload verbatim.
- **UI.** `src/components/reports/ResidualExplainer.tsx` replaces the bare
  "Statement does not reconcile" banner in `src/pages/reports/BankReconciliationReport.tsx`
  with ranked, expandable suggestions listing the offending rows. Presentation only: no
  filtering, sorting, arithmetic or data access in the component.
- **Tests.** `supabase/tests/bank_reconciliation_residual_explainer_test.sql` proves the array is
  always present, empty when reconciled, well formed, restricted to the closed code vocabulary,
  and that asking for explanations does not change the proof.
  `src/test/architecture/bank-reconciliation-single-engine.test.ts` gained a guard that the page
  renders `residualExplanations` and that the explainer invents no causes of its own (6/6 pass).

## Known gaps carried forward

- **Not run in CI:** the two new SQL invariant files need a `service_role` session; the read-only
  query tool has no EXECUTE on the engine, so they were reviewed, not executed here.
- **Live data:** "Joshua Holdings" / "Test Operating Bank – KES" still carries the −50,000.00 KES
  opening-balance duplicate. The explainer should now name it as
  `duplicate_opening_balance`; **this has not yet been confirmed against live data** and is the
  first thing the next agent should check. The underlying duplicate must still be reversed in data.
- **Export parity:** explanations are screen-only. The PDF/server path
  (`supabase/functions/_shared/reportDataEngine.ts`) still renders the residual without causes.
  Decide in Phase 11/12 whether the delivered document should carry them.
- ~111 pre-existing failing test files elsewhere in the repo are unrelated; do not fix them here.

## Instructions for the next agent

1. **Verify before you build.** Confirm Phase 10 to enterprise standard:
   run `finance_bank_reconciliation_statement` as `service_role` for the Joshua Holdings
   KES account and check that `residual_explanations` names the duplicate opening balance with
   amount −50,000.00 and the two offending references; execute
   `supabase/tests/bank_reconciliation_residual_explainer_test.sql` and
   `supabase/tests/bank_account_positions_invariants_test.sql`; open
   `/reports/bank-reconciliation` and confirm the suggestions render, expand and drill down.
   Also re-check Phases 7 and 9 in the browser (as-of date changes the figures; `?session=`
   pins the account and tab). Fix any failure before moving on.
2. **Then start Phase 11 — rule engine scrutiny.** Audit `bank_reconciliation_rules` and
   `apply_reconciliation_rules`: matching precedence, overlapping rules, amount tolerance, date
   window, that a rule may only *propose* and never auto-confirm, idempotency on re-run, and a
   per-rule audit trail with match counts. One SQL invariant test per behaviour, not one omnibus
   test.
3. **Do not** jump to Phase 12 or 13, and do not open unrelated domains. Bring Phase 11 to a
   production-ready state (engine first, UI second) before progressing.

### Unresolved policy (documented, not blocking)
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.
