# ADR 0138 — FX exposure reporting is a read-only projection of the one resolver

Status: Accepted
Date: 2026-08-12
Related: ADR-0136 (one FX engine, no silent parity), ADR-0123 (single journal posting monopoly)

## Context

Steps A–F converged the FX domain: one rate book (`public.exchange_rates`), one
precedence (`override > manual > provider`) in `resolve_exchange_rate`, one strict
wrapper (`require_exchange_rate`), one document stamper (`fx_stamp_document`) used by
both AR and AP, and one revaluation engine (`revalue_fx_balances`).

What was still missing was the question a controller asks *before* revaluing: what is
actually exposed right now, at what rate, from what source, and what would a revaluation
post? The obvious failure mode for that report is to grow a second engine — a client-side
conversion, a private open-balance definition, or a "close enough" 1:1 for currencies with
no rate on file — and then quietly disagree with the revaluation run for the same date.

## Decision

1. **Exposure is a projection, not an engine.**
   `public.fx_exposure_by_currency(business, as_of)` and
   `public.fx_exposure_open_items(business, currency, as_of)` are SECURITY DEFINER,
   gated on `user_can_access_business`, EXECUTE granted to `authenticated` only.
   They post nothing and they store nothing.
2. **Same resolver.** Every rate they return comes from `resolve_exchange_rate`, with its
   provenance (`source`, `provider_key`, `effective_date`, scope) carried onto the row.
3. **Same open-balance scope as revaluation.** The exposure functions reuse the
   open-item definition of `revalue_fx_balances`, so the report and the run can never
   present different numbers for the same date.
4. **A missing rate is an absence.** A currency with no rate on file returns
   `rate = null`, is listed in `missing_rates`, and renders as "No rate on file" with its
   booked value only. It is never dropped and never valued at 1:1.
5. **The browser formats, it does not compute.** `useFxExposure` /
   `useFxExposureOpenItems` call the RPCs and the report renders them. No client-side
   rate lookup, inversion or conversion is permitted on this surface.

## Consequences

- The FX Exposure report (`/finance/reports/fx-exposure`) is the pre-revaluation view:
  exposure per currency split across receivables, payables, cash & bank and other
  monetary accounts, with a document-level drill-down behind each currency.
- Adding a rate source or changing precedence changes the report automatically, because
  the report owns no resolution logic.
- Guard: `src/test/architecture/fx-single-engine.test.ts` fails CI if the exposure hook
  or page reads `exchange_rates` / `journal_entry_lines` directly, resolves a rate in the
  browser, or renders a missing rate as anything other than an absence.