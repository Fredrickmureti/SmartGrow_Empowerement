# FX: verification verdict, then Step G (exposure reporting) and the reversal carry-over

## Phase 1 — Verification of the previous session (evidence-backed)

Checked against the live database and the code, not the log.

Confirmed genuinely done:
- **Steps A/B (AP stampers).** `_tg_stamp_bill_currency`, `_tg_stamp_vcn_currency` and
  `_tg_stamp_purchase_return_currency` all now call the shared `fx_stamp_document`. No
  `COALESCE(..., 1)` parity fallback remains in any of them, each freezes a posted
  document via `_fx_document_is_posted`, and each re-stamps when the document date moves.
  `fx_stamp_document` calls `require_exchange_rate`, which raises `23514` on a missing rate.
- **Resolver precedence.** `resolve_exchange_rate` orders by effective date, then
  business-specific over org-wide, then `override > manual > provider`, then
  `published_at`, and returns NULL rather than inventing 1.
- **Step D.** `set_exchange_rate_override` and `set_business_active_currency` exist.
- **Step F.** `revalue_fx_balances`, `reverse_fx_revaluation_run` and
  `fx_revaluation_readiness` exist, and the readiness function is consumed by
  `useFxRevaluation`, `FinanceAccountingControls` and `ClosePeriodSheet`.
- **Step E.** The only client rate lookups are `@/services/fx/rateBook` and its thin
  readers (`CurrencyContext`, `useTenantFx`, `useAdminCurrency`, `platformUsd`,
  `usePlatformAdmin`, `AdminAnalytics`). Guards exist: `fx-single-engine`,
  `no-silent-currency-fallback`, `currency-integrity`, `credit-fx-policy`.

Correctly logged as pending:
- **Step G — FX exposure reporting.** No `fx_exposure*` function and no exposure surface
  exists anywhere in the codebase.
- **Reversal governance for vendor credit notes.** The document type is registered as
  reversible, but whether its reversal is approval-gated is unconfirmed and is the first
  thing that step will establish.

Worth stating plainly: `business_active_currencies` is still empty and `exchange_rates`
holds 13 provider rows with zero overrides, so the Step D and F paths are implemented but
have not yet been exercised with real tenant data. That is expected, not a defect — the
gates default open on the base currency.

Verdict: resume at Step G. No rework of Steps A–F is warranted.

## Phase 2 — Work to do

### Step G — FX exposure reporting (the active phase)
A controller must see what is at risk *before* revaluing, using the same resolver the
revaluation uses — no second engine, no client-side conversion.

1. `public.fx_exposure_by_currency(business, as_of)` — SECURITY DEFINER, gated on
   `user_can_access_business`, EXECUTE to `authenticated` only. Per foreign currency it
   returns open AR, open AP, open bank/cash balances, the booked base value of those open
   items, the rate `resolve_exchange_rate` gives at `as_of` (with `source`, `provider_key`,
   `effective_date`), the revalued base value, and the resulting unrealized difference.
   Currencies with no rate on file come back with a null rate and a flag — never silently
   dropped, never valued at 1:1. Reuses the open-item definitions of `revalue_fx_balances`
   so the two can never disagree.
2. `public.fx_exposure_open_items(business, currency, as_of)` — the document-level
   drill-down behind a currency row: document type, number, date, party, foreign amount,
   booked rate, booked base amount, current rate, revalued base, difference.
3. `useFxExposure` / `useFxExposureOpenItems` hooks and an **FX Exposure** report placed
   with the existing finance reporting surfaces, following the established report layout
   and masthead conventions. Each currency row expands to its open items. Missing rates
   render as `—` with an explicit "no rate on file" state linking to the rate book, per
   ADR 0136. Totals sit alongside the revaluation readiness the FX tab already renders.
4. Guard extension in `fx-single-engine.test.ts`: the exposure surface must not read
   `exchange_rates` directly from the client and must not compute a posted amount.

### Step H — Reversal governance carry-over (vendor credit notes)
First establish how approval gating is expressed for the document types that already have
it (invoice, bill, expense), then bring `vendor_credit_note` onto that exact mechanism —
no bespoke path. If the audit shows the gate already applies generically, record that and
close the item instead of adding code.

### Step I — Close the loop
- ADR 0138 recording the exposure report as a read-only projection of the one resolver.
- Update `mem://features/currency-and-fx-resolution` and the plan log with verified status.

## Technical notes
- Exposure is a **read-only projection**. It posts nothing and derives every rate from
  `resolve_exchange_rate` server-side; the browser only formats what the function returns.
- No new tables, no new resolver, no new rate store.
- Open-item scope is shared with `revalue_fx_balances` so the exposure report and the
  revaluation run can never present different numbers for the same date.