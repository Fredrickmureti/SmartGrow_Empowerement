# Project status — authoritative

Last updated: 2026-08-12 (session: FX convergence, Steps A–E)

## Programme: Enterprise Currency & FX convergence

Authority: ADR 0135 (supplier currency = proposal default), ADR 0136 (one FX engine,
no silent 1:1), ADR 0137 (provider credentials are server-only),
ADR 0123 (single journal posting monopoly).

## Completed and verified

**Rate book & resolver (DB)** — `public.exchange_rates` carries provenance
(`source`, `provider_key`, `published_at`, `created_by`). `resolve_exchange_rate`
implements `override > manual > provider`, latest effective date first;
`require_exchange_rate` is the strict wrapper. `publish_platform_rates()` bridges
`platform_exchange_rates` into the book on a 30-minute `pg_cron` schedule.

**Document snapshots (DB)** — `fx_stamp_document` stamps currency + rate on every
monetary document; posted documents are currency- and rate-immutable.

**Realized FX at settlement (DB)** — `record_multi_bill_payment` /
`record_multi_invoice_payment` post the booking-vs-settlement difference to the
realized FX accounts resolved by `resolve_fx_realized_account`.

**Provider credential hardening (DB + UI)** — ADR 0137. `credentials` is unreadable by
`authenticated`; all writes go through `save_integration_connection` /
`delete_integration_connection`. Guard: `provider-credential-isolation.test.ts`.

**Step A/B — AP stampers converged (DB, this session)** — `_tg_stamp_bill_currency`,
`_tg_stamp_vcn_currency`, `_tg_stamp_purchase_return_currency` and `_tg_stamp_po_currency`
now call the shared `fx_stamp_document`. The `COALESCE(NULLIF(currency_rate,0), 1)`
silent-parity hole is gone, documents re-stamp when the document date changes, and posted
documents are frozen via `_fx_document_is_posted`.

**Step C — Revaluation converged (DB, this session)** — `revalue_fx_balances` resolves
through `resolve_exchange_rate` and raises `23514` on a missing rate (recorded in the run's
`notes`) instead of silently skipping the balance.

**Step D — FX admin surface (DB + UI, this session)**
- `set_exchange_rate_override(business, from, to, rate, effective_date, reason)` —
  SECURITY DEFINER, `user_can_access_business` gated, validates the pair against
  `currencies`, rejects a non-positive rate and a future effective date, always inserts a
  **new** `source = 'override'` row (provider provenance is never mutated) and writes an
  `audit_logs` entry with the reason.
- `set_business_active_currency(business, currency, enabled)` — same gating; the base
  currency is force-enabled and cannot be disabled, so enabling a first foreign currency
  can never lock a company out of its own base currency.
- `src/components/settings/CurrencySettings.tsx` rebuilt: rate book with provenance
  (source badge, provider key, effective and published dates), override entry with a
  mandatory reason, operating-currency toggles, provider rows non-deletable.

**Step E — Client convergence & ratchets (this session)**
- `useAdminCurrency.usdToTargetRate` now delegates to `@/services/fx/rateBook`; its
  hand-rolled direct/reverse lookup is gone.
- New `@/services/fx/platformUsd` (`toPlatformUsd`, `sumPlatformUsd`) replaces the two
  duplicated `toUSD` engines in `usePlatformAdmin` and `AdminAnalytics`, which returned the
  **unconverted amount** on a missing rate. Unconvertible amounts are now excluded and
  counted, never summed at 1:1.
- All 24 `|| "USD"` silent fallbacks in `src/hooks`, `src/components`, `src/pages` removed:
  tenant writes take the business base currency (projects, employee advances, WMS tariffs),
  display formatters render `—` when a record has no currency, and the four genuinely
  USD-canonical platform-billing sites carry an explicit `architecture-allow` marker.
- Guards green: `fx-single-engine.test.ts` (16), `no-silent-currency-fallback.test.ts` (3),
  `currency-integrity.test.ts` (6), `no-client-payment-math.test.ts` (5),
  `credit-fx-policy.test.ts` (3). Typecheck clean.

## Pending

1. **Step F — Unrealized FX revaluation surface.** The engine (`revalue_fx_balances`,
   `useFxRevaluation`, `FxRevaluationReport`) exists and is now resolver-backed, but there
   is no period-end workflow around it: no scheduled/period-close trigger, no reversal of
   the prior period's unrealized entry, no run history UI beyond the report.
2. **Step G — FX exposure reporting.** Open AR/AP by currency with the rate used, so a
   controller can see exposure before revaluing.
3. **Reversal governance coverage** — approval-gated reversal for `vendor_credit_note`
   (carried over, unrelated to FX; do last).

## Active phase

Steps A–E are closed. **Next active phase: Step F — unrealized FX revaluation workflow.**

## Instructions for the next agent

1. **Verify this session's work before writing anything new.**
   - `bunx vitest run src/test/architecture/fx-single-engine.test.ts
     src/test/architecture/no-silent-currency-fallback.test.ts
     src/test/architecture/currency-integrity.test.ts
     src/test/architecture/provider-credential-isolation.test.ts` and
     `bunx tsgo --noEmit -p tsconfig.app.json`.
   - Read ADR 0135, 0136, 0137 first.
   - Database: confirm `set_exchange_rate_override` and `set_business_active_currency` exist,
     are SECURITY DEFINER, are EXECUTE-granted to `authenticated` only, and refuse a caller
     outside the business; confirm the AP stampers contain no `, 1)` parity fallback and that
     `revalue_fx_balances` raises rather than skipping.
   - Client: confirm no file outside `@/services/fx/rateBook` resolves a rate, and no
     `|| "USD"` exists without an `architecture-allow` marker.
2. Then resume at **Step F**, then G, then the reversal-governance carry-over, in order.
   Step F scope: reverse the prior period's unrealized entry on the next run, bind a run to a
   fiscal period, block a period close while an un-run revaluation exists for an open foreign
   balance, and give the run history a UI with the rate used per balance.
3. Do not start unrelated work and do not leave a step partially implemented.
4. Note: the full `src/test` suite times out under sandbox contention — environmental and
   pre-existing. Run targeted suites.
