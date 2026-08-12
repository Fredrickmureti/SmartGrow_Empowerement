# Project status — authoritative

Last updated: 2026-08-12

## Programme: Enterprise Currency & FX convergence (ACTIVE)

Authority: ADR 0135 (supplier currency = proposal default), ADR 0136 (one FX engine),
ADR 0123 (single journal posting monopoly).

### Completed and verified

**Step 1–3 — Canonical rate book (DB)**
- `public.exchange_rates` gained provenance: `source`, `provider_key`, `published_at`, `created_by`.
- `resolve_exchange_rate` implements deterministic precedence `override > manual > provider`,
  latest effective date first; `require_exchange_rate` is the strict raising wrapper.
- `publish_platform_rates()` bridges `platform_exchange_rates` (market data) into the accounting
  book with USD-anchored triangulation; scheduled every 30 min via `pg_cron`. Book seeded with
  13 provider rates.

**Step 5–7 — Document snapshot layer (DB)**
- `exchange_rate` snapshot columns added to `estimates`, `credit_notes`, `customer_refunds`,
  `purchase_orders`.
- Hardcoded `'USD'`/`'KES'` column defaults removed from transaction tables.
- Shared stamper `fx_stamp_document` wired into document triggers; posted invoices and credit
  notes are currency- and rate-immutable.

**Step 8 — Realized FX gain/loss at settlement (DB)**
- `resolve_fx_realized_account` resolves the gain/loss ledger accounts.
- `record_multi_bill_payment` and `record_multi_invoice_payment` rewritten FX-aware: posting in
  base currency, difference between booking rate and settlement-date rate posted to realized FX.
- Stale 17-arg `record_multi_bill_payment` overload dropped (call ambiguity resolved).

**Step 4 — Kill the parallel client engines (DONE this session)**
- New single client lookup `src/services/fx/rateBook.ts` (`resolveRateFromBook`,
  `convertWithBook`): server-mirroring precedence, base-currency pivot, `null` for a missing
  pair — never 1.
- `CurrencyContext` delegates to it; `getExchangeRate`/`convertCurrency` now return
  `number | null`; manual entry inserts `source: 'override'` instead of upserting over provider rows.
- `useTenantFx` retargeted from `platform_exchange_rates` to the org-scoped accounting book and
  delegated to the shared lookup.
- `useAdminCurrency`: literal `129.5` removed, `usdToTargetRate`/`convertAmount` return
  `number | null`, `formatCurrency` renders `—` when no rate is on file.
- Consumers updated for the honest null: `Dashboard`, `ExecutiveDashboard`,
  `BranchComparisonWidget`, `CurrencyConverter`, `CurrencyToggle`, `AdminReports`.
- ADR 0136 written. Guard `src/test/architecture/fx-single-engine.test.ts` — 10 tests, green.
  Typecheck clean on all touched files.

## Pending

1. **Step 9 — Provider credential hardening.** Provider credentials are stored in plaintext
   JSONB and provider selection is reachable from the browser. Move credentials to secrets,
   remove browser-side provider selection, keep the ingest server-only.
2. **Step 10 — FX admin surface & provenance UI.** Tenant screen to view the rate book, enter an
   override (with reason), and see `source` / `provider_key` / `published_at` per row, plus
   seeding of `business_active_currencies`.
3. **Step 11 — Unrealized FX revaluation** of open AR/AP balances at period end (currently absent).
4. **Reversal governance coverage** — approval-gated reversal for `vendor_credit_note`
   (carried over, unrelated to FX; do last).

## Active phase
Step 4 closed. **Next active phase: Step 9 — provider credential hardening.**

## Instructions for the next agent
1. **Verify before continuing.**
   - Run `bunx vitest run src/test/architecture/fx-single-engine.test.ts
     src/test/architecture/currency-integrity.test.ts
     src/test/architecture/reversal-intent-coverage.test.ts`.
   - In the database, confirm: `exchange_rates` has the provenance columns and non-empty
     provider rows; the `publish_platform_rates` cron job is scheduled; `resolve_exchange_rate`
     applies `override > manual > provider`; the `fx_stamp_document` triggers are attached to
     every monetary document table; `record_multi_invoice_payment` /
     `record_multi_bill_payment` post realized FX lines.
   - Confirm no client file resolves a rate outside `@/services/fx/rateBook`.
   - Read ADR 0135 and ADR 0136 first.
2. Then resume at **Step 9**, then 10, 11 in order. Do not start unrelated work and do not leave
   a step partially implemented.
3. Note: the full `src/test` suite times out under sandbox contention — environmental and
   pre-existing. Run targeted suites.
