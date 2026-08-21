# Currency & FX — Phase 7 (unrealized FX): verification result and execution plan

## 1. Verification of the previous engineer's claims (this turn)

Each claim was re-checked against the live database and the codebase, not the log.

CONFIRMED (VERIFIED FACT):
- One resolver / one book: `resolve_exchange_rate`, `require_exchange_rate`,
  `fx_stamp_document`, `post_journal_entry_atomic` each exist exactly once, are
  SECURITY DEFINER with a pinned `search_path`.
- Refund fix is real: `refund_customer_atomic` and `refund_from_vendor_atomic`
  both resolve `bank_accounts.account_id` into `v_bank_gl` and raise
  `Bank account % has no general ledger account configured` when absent.
- Bank-match fix is real: `bank_match_confirm` no longer passes a caller rate; it
  derives the transaction currency (bank-account currency as fallback, not base)
  and calls `require_exchange_rate` itself before delegating to
  `record_multi_invoice_payment` / `record_multi_bill_payment`.
- Revaluation uses the one resolver: `revalue_fx_balances` calls
  `resolve_exchange_rate` and records a missing rate on the run instead of
  skipping silently.
- Line-level FX metadata exists on `journal_entry_lines`
  (`original_currency`, `original_debit`, `original_credit`, `exchange_rate`).
- All five tie-out fixtures and both structural guards exist on disk;
  `fx-single-engine.test.ts` carries 29 guards.
- Currency entry in Settings is already catalogue-driven (a `Select` over
  `currencies`, base side locked) — the "users type the currency" concern in the
  parent prompt is not reproducible on that surface.
- Monetary/non-monetary classification exists as `public.fx_is_monetary_account`
  and is used by `revalue_fx_balances`, `fx_exposure_by_currency`,
  `fx_exposure_open_items`, `fx_exposure_dimensions`.

INVALIDATED / NEW DEFECTS (VERIFIED FACT):
1. **`fx_revaluation_readiness` is broken at runtime.** Its body reads
   `upper(COALESCE(base_currency, default_currency)) FROM public.businesses`, but
   `businesses` has only `base_currency` — no `default_currency` column exists in
   the schema. Any execution raises `42703`. Consequences: (a)
   `close_fiscal_period` calls it before every close, so **no fiscal period can
   be closed at all**; (b) `ClosePeriodSheet` and the FX tab of
   `FinanceAccountingControls` silently lose their readiness signal.
2. **Same function is the one surviving pre-monetary-classifier path.** It scopes
   eligibility with `a.account_type IN ('asset','liability')` instead of
   `fx_is_monetary_account`, so its answer disagrees with the engine it gates:
   inventory, fixed assets, prepayments and deferred revenue would be demanded
   for revaluation (ACCOUNTING PRINCIPLE, IAS 21: non-monetary items stay at the
   historical rate). `fx_revaluation_lifecycle_test.sql` already asserts this and
   therefore currently fails.
3. **Parity fallback survives in the expense posting path.** `post_expense_gl`
   contains `COALESCE(e.exchange_rate, 1)`, i.e. a foreign expense with an
   unstamped rate posts at 1:1 — the exact hole ADR 0136 forbids. Whether
   expenses can actually reach that state (is the stamp mandatory?) is
   **UNVERIFIED** and is step 0 below.
4. Live data carries **zero** foreign-currency journal entries, so nothing above
   was caught by production data and no backfill is implied. Fixtures are the
   only evidence source; treat them as mandatory.

## 2. Accounting invariants this phase must hold

- Only monetary items are revalued; one classifier (`fx_is_monetary_account`)
  decides, everywhere.
- A missing rate is a visible absence: never 1, never base-currency coercion.
- The prior period's revaluation is reversed before the next is computed, so
  unrealized FX cannot accumulate.
- Realized FX at settlement and unrealized FX at revaluation never double-count
  the same movement.
- Revaluation posts to the legal entity, never to a branch.

## 3. Execution order (dependency-derived, smallest safe sequence)

**Step 0 — verify the expense hole (investigation, no fix yet).**
Determine whether `expenses.exchange_rate` is stamped by a trigger through
`fx_stamp_document`/`require_exchange_rate` and whether it can be NULL/0 on a
foreign expense. Verdict drives Step 3.

**Step 1 — repair `fx_revaluation_readiness` (blocker).**
Rewrite it to read `businesses.base_currency` only and to scope eligibility
through `fx_is_monetary_account`, matching `revalue_fx_balances` exactly (same
scope, same resolver, same open-balance definition). No second scope definition.

**Step 2 — prove the revaluation lifecycle end to end.**
Run `fx_revaluation_lifecycle_test.sql` as a self-aborting fixture; extend it to
cover: first run posts, second run for the same period is idempotent, prior run
reverses via `reverse_fx_revaluation_run` before the next is computed, a missing
rate is recorded as an exception rather than skipped, close is blocked while
unrevalued monetary balances exist and permitted after the run, and a
non-monetary foreign balance is never revalued.

**Step 3 — remove the expense parity fallback (only if Step 0 confirms reachable).**
Make the expense rate mandatory at stamp time and delete
`COALESCE(e.exchange_rate, 1)` from `post_expense_gl` so it raises instead of
posting at parity. Add the SQL guard.

**Step 4 — ratchets.**
Extend `fx_revaluation_lifecycle_test.sql` / `fx-single-engine.test.ts` to fail
on: any FX scope predicate not using `fx_is_monetary_account`, any
`COALESCE(<rate>, 1)` in a posting path, any reference to a non-existent
`businesses.default_currency`, and any settlement path accepting a caller rate.

**Step 5 — isolation re-check for the touched surface only.**
Confirm the repaired readiness function keeps its `user_can_access_business`
guard and that revaluation runs, exposure and readiness are business-scoped.

## 4. Scope boundaries

In scope: `fx_revaluation_readiness`, `revalue_fx_balances`,
`reverse_fx_revaluation_run`, `close_fiscal_period` interaction, the expense
posting rate fallback, and the guards listed above.
Out of scope this phase: the AR/AP/bank realized-FX routes (verified above, do
not touch), FX reporting surfaces, the vendor-credit-note reversal-approval
carry-over, and everything outside FX.

## 5. Execution status

- Verification: complete.
- Steps 0–5: not started.

## 6. Answer to the parent prompt's final question

Not yet fully. Producers and settlement routes do supply authoritative,
line-level, server-stamped FX data (verified), and realized FX is centralised.
Two breaks remain: the period-close readiness gate cannot execute at all and
disagrees with the engine's monetary scope, and the expense posting path retains
a 1:1 fallback. Steps 0–4 above are the minimum dependency-ordered sequence to
make the contract trustworthy.
