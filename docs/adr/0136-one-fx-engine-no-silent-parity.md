# ADR 0136 — One FX engine; a missing rate is a visible absence, not 1:1

Status: Accepted
Date: 2026-08-12
Related: ADR-0123 (single journal posting monopoly), ADR-0135 (supplier currency is a proposal default)

## Context

The audit found three parallel client-side conversion engines and a disconnected
rate supply chain:

- `CurrencyContext.getExchangeRate` triangulated through a hardcoded `"USD"` pivot and
  **returned `1` when no rate was found** — every dashboard, executive KPI and branch
  comparison could silently display an unconverted number wearing a foreign symbol.
- `useTenantFx` read `platform_exchange_rates` (raw platform market data) directly,
  bypassing tenant overrides and the accounting book entirely.
- `useAdminCurrency` returned `1` on a missing path and carried a literal
  `usdToKesRate = 129.5` fallback.
- The provider pipeline wrote to `platform_exchange_rates` while the accounting resolver
  read `public.exchange_rates`, which was empty.

## Decision

1. **One rate book.** `public.exchange_rates` is the only book any accounting or tenant
   display path reads. Provider market data lands in `platform_exchange_rates` and is
   bridged into the book by the server-side publisher `publish_platform_rates()`
   (scheduled), which stamps `source`, `provider_key`, `published_at`.
2. **One precedence, defined server-side.** `override > manual > provider`, latest
   effective date first, evaluated by `public.resolve_exchange_rate`;
   `require_exchange_rate` is the strict wrapper used by document triggers.
3. **One client lookup.** `@/services/fx/rateBook` (`resolveRateFromBook` /
   `convertWithBook`) is the only client-side rate resolution. `CurrencyContext` and
   `useTenantFx` are thin readers over it; no component may re-implement lookup,
   inversion or triangulation.
4. **Display-only on the client.** The browser may render a resolved rate. It may never
   compute an amount that is posted. Booking and settlement rates are stamped server-side
   by the document triggers and the settlement engines (ADR-0123).
5. **A missing rate is `null`, and `null` renders as an absence.** No engine returns `1`
   for an unknown pair and no code path carries a rate literal. Surfaces render `—` (or an
   explicit "no rate on file" message) instead of a misleading figure.
6. **Tenant-entered rates are overrides.** Manual entry inserts `source = 'override'`; it
   never mutates or masquerades as the published provider row, so provenance survives.

## Consequences

- Multi-currency dashboards now show `—` where they previously showed an unconverted
  number. That is the intended, honest behaviour.
- Every displayed rate answers "where did it come from": the row carries `source`,
  `provider_key` and `published_at`.
- Guard: `src/test/architecture/fx-single-engine.test.ts` fails CI on a reintroduced
  silent `1`, a rate literal, or a second client lookup.
