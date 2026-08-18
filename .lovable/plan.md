# Banking Wave 1 — Phase 5b: currency & FX parity with the canonical pattern

## Verified state (checked this turn, not taken from the ledger)

- `LandedCostCreatePage` is the correct pattern: `CurrencyCombobox` fed by the **full**
  canonical catalogue (`useCurrencies`), default = business base currency, and a live
  `describe_exchange_rate` panel that shows rate + provenance (override / manual /
  provider / base) and a **hard red "no rate on file"** state that blocks save. The browser
  sends no rate; `fx_stamp_document` stamps it server-side.
- `BankAccountCreatePage` / `BankAccountEditPage` use `CurrencyCombobox` but feed it
  `useBusinessActiveCurrencies` — a narrowed list that collapses to just the base currency
  when a company has published no `business_active_currencies` rows. There is **no rate
  display and no missing-rate warning anywhere on either page**.
- The comment in `useBusinessActiveCurrencies` claims "the server-side seams (e.g.
  `bank_account_create`) validate against exactly this set". That claim is **false**:
  `bank_account_create` only calls `normalize_currency_code` and falls back to the base
  currency. No `business_active_currencies` check exists in the function.
- `_bank_account_post_opening_balance` posts the opening-balance JE through
  `post_journal_entry_atomic` passing the account currency with a **NULL exchange rate**.
  So a foreign-currency opening balance is posted with no rate the operator ever saw, and
  the operator gets no warning beforehand that the rate book has no coverage.

Net: the banking form is a shallower, differently-wired copy of a pattern this codebase
already got right. That is the duplication to remove — not by adding a new engine, but by
making Banking consume the landed-cost pattern verbatim.

## Decision

Banking adopts the landed-cost currency contract exactly. No new hook, no new picker, no
banking-specific FX code.

1. Currency source = the canonical catalogue (`useCurrencies`), same as landed cost.
   Retire `useBusinessActiveCurrencies` from the banking pages. (Keep the hook only if
   another consumer still needs it; otherwise delete it — no legacy fallback.)
2. Add the same read-only FX panel to bank account create and edit, driven by
   `describe_exchange_rate(org, business, currency, opening_balance_date)`:
   - currency = base → "already in base currency, no conversion applies"
   - rate found → `1 CUR = x BASE`, plus source + effective date provenance
   - no rate → red destructive block, identical wording/behaviour to landed cost, and
     **save is disabled** while a non-base opening balance would post without a rate.
3. The browser still sends no rate. Server keeps ownership.

## Server-side repairs required by the above

- `_bank_account_post_opening_balance`: stop passing NULL. Resolve through
  `require_exchange_rate` for a non-base account currency so a rateless foreign opening
  balance raises instead of posting silently. Missing rate = refusal, never 1:1.
- `bank_account_create` / `bank_account_update`: validate the submitted currency against
  `public.currencies` active codes (the same set the picker now shows), so the seam and the
  UI finally agree. Remove the now-false comment in the hook.

## Tests

- Extend `src/test/architecture/banking-currency-integrity.test.ts`: banking pages must
  reference `describe_exchange_rate`, must not reference `useBusinessActiveCurrencies`, and
  must keep the existing no-1:1 / no-country-fixture ratchets.
- SQL test: foreign-currency opening balance with no rate on file raises; with a rate,
  posts one JE and is idempotent.

## Out of scope

Reconciliation, feeds, and the Phase 6-9 items in the previous ledger
(SQL invariant suite, `current_balance` provenance defect D-7, ADR + memory update) stay
queued and follow this phase.

## Next step after approval

Wire the FX panel + catalogue picker into both banking pages, then the two server repairs,
then the ratchets.
