# Project status — authoritative

Last updated: 2026-08-12

## Programme: Enterprise Currency & FX convergence (ACTIVE)

Authority: ADR 0135 (supplier currency = proposal default), ADR 0136 (one FX engine),
ADR 0137 (provider credentials are server-only), ADR 0123 (single journal posting monopoly).

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

**Step 4 — Kill the parallel client engines**
- New single client lookup `src/services/fx/rateBook.ts` (`resolveRateFromBook`,
  `convertWithBook`): server-mirroring precedence, base-currency pivot, `null` for a missing
  pair — never 1.
- `CurrencyContext`, `useTenantFx`, `useAdminCurrency` all delegate to it; literal `129.5`
  removed; missing rate renders `—`.
- Consumers updated for the honest null: `Dashboard`, `ExecutiveDashboard`,
  `BranchComparisonWidget`, `CurrencyConverter`, `CurrencyToggle`, `AdminReports`.
- ADR 0136 written. Guard `src/test/architecture/fx-single-engine.test.ts` — 10 tests, green.

**Step 9 — Provider credential hardening (DONE this session)**
- DB: `platform_integration_connections` gained non-secret metadata `credential_keys text[]` and
  `credentials_set_at`, maintained by trigger `sync_integration_credential_meta`.
- DB: all privileges revoked from `anon`/`authenticated`; column-level SELECT re-granted on every
  column **except `credentials`**; `service_role` keeps full access for the edge functions.
  Verified: `has_column_privilege('authenticated', …, 'credentials', 'SELECT') = false`,
  `has_table_privilege('authenticated', …, 'UPDATE') = false`, `service_role` read = true.
- DB: single guarded write path `save_integration_connection(...)` and
  `delete_integration_connection(...)` — SECURITY DEFINER, `is_platform_admin` gated,
  provider/capability validated, single-active enforced, blank credential fields keep the stored
  secret, every change written to `audit_logs`.
- Client: `useIntegrationProviders` selects an explicit non-secret column list, exposes
  `credential_keys` / `credentials_set_at`, and writes only through the two RPCs.
- UI: `IntegrationProviderManager` no longer hydrates secrets into React state; stored fields show
  "Stored — leave blank to keep" plus the last-updated time.
- Ingest unchanged: `provider-run` / `provider-test` read credentials with the service role.
- ADR 0137 written. Guard `src/test/architecture/provider-credential-isolation.test.ts` —
  4 tests, green. Typecheck clean.

## Pending

1. **Step 10 — FX admin surface & provenance UI.** Tenant screen to view the rate book, enter an
   override (with reason), and see `source` / `provider_key` / `published_at` per row, plus
   seeding of `business_active_currencies`.
2. **Step 11 — Unrealized FX revaluation** of open AR/AP balances at period end (currently absent).
3. **Reversal governance coverage** — approval-gated reversal for `vendor_credit_note`
   (carried over, unrelated to FX; do last).

## Active phase
Step 9 closed. **Next active phase: Step 10 — FX admin surface & provenance UI.**

## Instructions for the next agent
1. **Verify before continuing.**
   - Run `bunx vitest run src/test/architecture/fx-single-engine.test.ts
     src/test/architecture/provider-credential-isolation.test.ts
     src/test/architecture/currency-integrity.test.ts
     src/test/architecture/reversal-intent-coverage.test.ts`.
   - Read ADR 0135, 0136, 0137 first.
   - Database checks: provenance columns and provider rows present in `exchange_rates`;
     `publish_platform_rates` cron scheduled; `resolve_exchange_rate` precedence
     `override > manual > provider`; `fx_stamp_document` attached to every monetary document
     table; realized FX lines posted by `record_multi_*_payment`;
     `has_column_privilege('authenticated','public.platform_integration_connections',
     'credentials','SELECT')` is **false**.
   - Confirm no client file resolves a rate outside `@/services/fx/rateBook` and no client file
     reads or writes connection credentials.
2. Then resume at **Step 10**, then 11, then the reversal-governance carry-over, in order.
   Step 10 scope: read-only rate-book table with provenance columns, admin override entry
   (writes `source = 'override'` with a reason, server-validated), and
   `business_active_currencies` seeding so tenants can pick their operating currencies.
3. Do not start unrelated work and do not leave a step partially implemented.
4. Note: the full `src/test` suite times out under sandbox contention — environmental and
   pre-existing. Run targeted suites.
