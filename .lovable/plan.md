# Currency & FX — handover verification verdict (2026-08-21) + remaining execution

Authority: ADR 0135 / 0136 / 0138. Scope boundary unchanged:
FX source → settlement → posting → FX engine → FX reporting. No second resolver,
no client-side conversion, no unrelated module work.

Status vocabulary: VERIFIED FACT (checked in live DB / code this session) ·
ACCOUNTING PRINCIPLE · INFERENCE · UNVERIFIED.

## Verdict on the previous engineer's claims

Phases 1–5 were checked against `pg_proc`, the live schema, and the test suite.
**Most claims hold; four do not.**

Confirmed (VERIFIED FACT):
- `post_journal_entry_atomic` has exactly one overload; last parameter is
  `_amounts_in_document_currency boolean DEFAULT NULL`.
- `convert_po_to_bill_atomic` no longer reads `exchange_rates` and has no parity
  fallback (the only `COALESCE(...,1)` hit is a comment).
- `expense_reimburse_direct`: no parity fallback, uses `resolve_exchange_rate`,
  references `resolve_fx_realized_account`.
- `pos_payment_session_open`: no `'KES'` literal, resolves server-side.
- `confirm_bill_atomic` **does** opt in — it passes `_currency`, `_exchange_rate`
  and `true` **positionally**. The earlier "passes no `_currency`" finding is
  INVALIDATED, and so is any named-argument regex check over it.
- `revalue_fx_balances` now groups by line-level `original_currency`, filters
  eligibility through `fx_is_monetary_account(account_type, detail_type)` (not the
  old `asset OR liability` rule), fails loudly on a missing rate, and reverses the
  prior `next_period` run. The old eligibility/grouping defect is FIXED.
- Grant leak is closed except one: only `set_business_active_currency` still
  carries `anon=X` (fails closed on `auth.uid() IS NULL`).

Invalidated / newly found defects:

**F1 — Silent parity on the historical leg of realized FX (critical).**
`record_multi_invoice_payment:240` selects `COALESCE(exchange_rate, 1) AS exchange_rate`
from `invoices`, and `record_multi_bill_payment:167` selects
`COALESCE(currency_rate, 1)` from `bills`; the AP/AR relief is then computed as
`amount * that rate`. `invoices.exchange_rate` is **nullable with no default**
(VERIFIED schema), so a foreign invoice whose rate was never stamped is relieved at
1:1 and the realized FX difference is fabricated. This is precisely the
`COALESCE(rate, 1)` pattern ADR 0136 forbids, surviving inside the two paths the
plan lists as the realized-FX reference implementation.
Accounting consequence: AR/AP relieved at the wrong historical rate → realized
gain/loss misstated, control account drifts from the subledger.

**F2 — The two SQL contract tests now contradict each other.**
`supabase/tests/journal_denomination_contract_test.sql` asserts
`_amounts_in_document_currency := true` (named form) for `confirm_bill_atomic`,
`refund_customer_atomic`, `refund_from_vendor_atomic` and
`apply_credit_to_invoice_atomic`. In the live DB those four do not contain that
string: `confirm_bill_atomic` opts in positionally, and the other three
deliberately pass `_amounts_in_document_currency := false` (Phase 4 made them post
pre-converted base lines, which `fx_settlement_realized_test.sql` then asserts).
So the older test would raise on four functions. VERIFIED FACT. The contract, not
the code, is stale — but until it is reconciled neither test can be trusted as a
ratchet.

**F3 — Live guard failure, not disclosed in the status file.**
`src/test/architecture/no-silent-currency-fallback.test.ts` FAILS:
`src/components/banking/BankAccountCard.tsx:222` renders
`formatAmount(displayBalance, account.currency || "USD")`. VERIFIED by running the
suite (1 failed / 38 passed across the four FX guard files).

**F4 — Nothing is accounting-verified. `company_currency_total`/`original_*` are unproven.**
Live counts: `journal_entries` with a foreign header currency = **0**;
`journal_entry_lines` with `original_currency` non-null = **0** (28 lines total);
foreign `bills` = 0; foreign `invoices` = 0; `exchange_rates` = 130 rows;
`business_active_currencies` = **1** row; `fx_revaluation_runs` = 1.
Every conclusion about the posting path is catalog-level only. Phase 6's tie-out
cannot be asserted without a real foreign fixture.

**F5 — Currency literal baked into the schema.**
`customer_credit_balances.currency` is `NOT NULL DEFAULT 'KES'` (VERIFIED). A
tenant whose base currency is not KES gets mislabelled credit balances. `bills.currency_rate`
is `NOT NULL DEFAULT 1` — the default is the enabler for F1 on the AP side.

## Accounting invariants being enforced (unchanged, restated)

1. Denomination is owned by the business document and frozen by the BEFORE stamper.
2. Booking rate comes only from `fx_stamp_document` → `require_exchange_rate`.
3. Settlement rate is resolved server-side on the settlement date.
4. A monetary balance is relieved at its **own booking rate**; the delta vs the
   settlement rate is realized FX via `resolve_fx_realized_account`.
5. A missing rate raises. Never `COALESCE(rate, 1)`, never a currency literal.
6. `post_journal_entry_atomic` is the only converter; callers either hand it
   document-currency lines with the opt-in, or already-base lines with `false`.
7. Unrealized FX is entity-level (`branch_id NULL`) and only for accounts
   `fx_is_monetary_account` accepts.

## Execution order (dependency-derived)

**Phase A — close F1 (blocks Phase 6).**
Remove both `COALESCE(<rate>, 1)` reads. Relieve at the stamped document rate and
raise `23514` when a foreign document carries no rate. Add a NOT NULL/positive-rate
check on the foreign path rather than a default. Extend
`fx_settlement_realized_test.sql` with an explicit "no parity fallback in the
multi-document settlement RPCs" assertion covering the `invoices`/`bills` reads.

**Phase B — reconcile the contract tests (F2).**
Rewrite the `journal_denomination_contract_test.sql` block so it asserts the
*behaviour* (opt-in present, named **or** positional; base-line posters assert
`false` plus a base-conversion done by the caller) instead of a literal named
argument. One contract file must not contradict the other.

**Phase C — fix F3 and re-green the ratchets.**
`BankAccountCard` renders `—` (or the account's own currency with no fallback);
never `"USD"`. Then all four FX guard files pass.

**Phase D — F5 schema hygiene.**
Drop the `'KES'` default on `customer_credit_balances.currency` and backfill from
`businesses.base_currency`; drop the `anon` EXECUTE on
`set_business_active_currency`.

**Phase E — Phase 6 from the old plan: realized-FX vs GL tie-out.**
Requires a foreign fixture (F4). Build one deterministic foreign end-to-end path
(enable a currency, publish a rate, foreign invoice → partial payment → full
payment) and assert: line `original_*` populated, header currency+rate stamped,
sum of realized FX postings = GL movement on the realized gain/loss accounts per
business and period.

**Phase F — Phase 7: period-close interlock.**
Closing a fiscal period refuses when an enabled currency has no rate on file at
period end.

## Tests required

- `supabase/tests/fx_settlement_realized_test.sql` — Phase A assertion.
- `supabase/tests/journal_denomination_contract_test.sql` — rewritten per Phase B.
- `src/test/architecture/no-silent-currency-fallback.test.ts` — must pass (Phase C).
- New SQL contract test for the Phase E tie-out and the Phase F interlock.

## Carried limitations (documented, not defects)

- `payments` / `customer_credit_balances` have no usable currency+rate pair, so
  advances are structurally base-currency only. Foreign advances need a schema
  decision — do not start without one.
- Unrelated pre-existing failure, not FX:
  `src/test/architecture/bill-payment-allocations-first-class.test.ts`.

## Explicit non-goals

No new rate table, no second resolver, no client-side conversion, no reporting-layer
work, no rewrite of Sales (verified clean), no ERP-wide audit.

## Final answers

**Is the centralized FX engine receiving trustworthy, complete, correctly-denominated
data from every relevant producer?** Not yet — and not for the reason previously
recorded. The centre (rate book, resolver pair, stamper, converter, revaluation
eligibility) is now structurally sound and the producer sweep is genuinely largely
done. Two things break the contract: the multi-document settlement RPCs still fall
back to a 1:1 historical rate (F1), and no foreign-currency transaction has ever
been posted in this database, so the contract is unproven in practice (F4).

**Smallest dependency-ordered sequence:** A → B → C → D → E → F, as above.
