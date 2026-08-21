# Currency & FX — engine trust programme (authoritative status)

Last updated: 2026-08-21. Authority: ADR 0135 / 0136 / 0138 and
`mem://features/currency-and-fx-resolution`.

## Verdict on the contract

**Is the centralized FX engine receiving trustworthy, complete, correctly-denominated
data from every producer?** It is now, for the producer paths audited. Three real defects
were found and closed; one suspected defect was disproven.

- F1 (closed) — `revalue_fx_balances` took the reporting currency from the caller.
- F2 (closed) — unrealized gain/loss accounts were chosen per run in the browser while
  realized FX used a central resolver.
- F4 (closed) — the FX control panel exposed a free-text base currency and account pickers.
- F3 (not a defect) — `resolve_sales_exchange_rate` is a one-line delegation to
  `resolve_exchange_rate`. An alias, not a second engine.

## Fully implemented and verified

### Phase C — result-account and revaluation-input hardening (complete)
1. `system_account_roles` + `account_role_eligibility` carry `fx_unrealized_gain` and
   `fx_unrealized_loss`, mirroring the realized pair.
2. `resolve_fx_account(business_id, purpose)` — one resolution order for all four FX P&L
   roles: Default Accounts mapping → legacy `default_accounts.purpose` → eligibility
   catalogue → name heuristic → raise. `resolve_fx_realized_account` and
   `resolve_fx_unrealized_account` are wrappers over it.
3. `revalue_fx_balances` derives the reporting currency from `businesses.base_currency`,
   rejects a mismatched caller value, and resolves both FX accounts server-side.
4. `useFxRevaluation.runRevaluation` takes only a run date; the control panel shows the
   entity's reporting currency read-only and names where the accounts come from.
5. All four FX accounts are mappable in Settings → Default Accounts.
   Verified: `bunx tsgo --noEmit -p tsconfig.app.json` clean.

### Phase D / Step 5 — exposure dimensions (complete)
6. `public.fx_exposure_dimensions(_business_id, _as_of, _currency)` — counterparty
   (`journal_entry_lines.contact_id`, unattributed rows labelled) and ageing
   (0-30 / 31-60 / 61-90 / 90+ from the posting date) cuts. Same open-balance scope,
   same `fx_is_monetary_account` filter and the same `describe_exchange_rate` resolution
   as `fx_exposure_by_currency` and `revalue_fx_balances`, so the three can never disagree.
   Currencies with no rate return `NULL` conversions and are listed in `missing_rates`.
   `SECURITY DEFINER`, `user_can_access_business` gated, `EXECUTE` revoked from anon.
7. `useFxExposureDimensions` + two sections on `/finance/reports/fx-exposure`; selecting a
   currency filters both cuts. The browser buckets nothing and resolves no rate.
8. Guards in `src/test/architecture/fx-single-engine.test.ts` (24 passing): the browser may
   not send `_base_currency` or an `_unrealized_*_account`, the panel may not offer a
   free-text currency or per-run account picker, and the exposure page may not carry
   ageing-bucket or rate logic of its own.

### Phase E / Step 6 — operating-currency enablement (complete)
9. `_seed_business_base_currency` (AFTER INSERT OR UPDATE OF `base_currency` on
   `businesses`) guarantees every company carries an enabled row for its own base
   currency. Existing companies were backfilled; `business_active_currencies` is no
   longer empty anywhere, so the gate is live rather than inert.
10. `_bac_protect_base_currency` (BEFORE INSERT/UPDATE/DELETE) normalises the code,
    rejects codes absent from the platform catalogue, and refuses to disable or delete
    the base-currency row on any path — RPC, Data API or admin SQL.
    Verified live: `UPDATE ... SET is_enabled = false` on the base row raises 22023.
11. `_expenses_derive_base_amount` lost the `count(*) > 0` escape hatch. Expenses now
    refuse a non-enabled currency unconditionally, matching `bank_accounts` and
    `procurement_contracts`. Safe because the seed guarantees the base row exists.
12. `list_business_active_currencies(_business_id)` — `SECURITY DEFINER`,
    `user_can_access_business` gated, `authenticated` only — returns the enabled set with
    a server-resolved `is_base` flag. Settings → Currency reads through it and writes only
    through `set_business_active_currency`; it no longer touches the table directly.
13. Guard added (25 passing): the settings screen may not query
    `business_active_currencies` at all, read or write.

## Currently active phase

None in flight — Phase E closed cleanly. Nothing is half-built.

## Pending, in the order it should be taken

1. **Step 7 — realized-FX GL tie-out proof (next).** Unprovable today for lack of data,
   not failing: no tenant has a posted journal line on a realized FX account, so
   realized-report vs GL is 0 = 0. Seed a foreign-currency settlement in a test fixture,
   re-run the tie-out, and land it as a SQL test under `supabase/tests/`.
2. **Step 8 — period-close interlock.** A period should not close while
   `fx_exposure_by_currency` reports a currency with no rate on file.

## Instructions for the next agent

1. **Verify before continuing.** Do not trust this file. Confirm in the live database that
   `list_business_active_currencies`, `_seed_business_base_currency` and
   `_bac_protect_base_currency` exist with the described bodies and triggers attached, that
   every business has an enabled base-currency row, that disabling a base row raises, and
   that `_expenses_derive_base_amount` no longer contains a `count(*)` hatch. Also re-verify
   Phase C/D: `resolve_fx_account`, `resolve_fx_unrealized_account`,
   `fx_exposure_dimensions`, and that `revalue_fx_balances` raises on a caller-supplied
   currency differing from `businesses.base_currency`. `EXECUTE` on each should be
   `authenticated` only. Then run
   `bunx vitest run src/test/architecture/fx-single-engine.test.ts` (expect 25 passing) and
   `bunx tsgo --noEmit -p tsconfig.app.json`.
2. **Then resume at Step 7**, not at unrelated work. Bring it to a production-ready state —
   fixture, tie-out query and SQL test together — before opening Step 8.
3. Keep the invariants: one rate book, one resolver, server-side booking rates, missing rate
   renders as an absence, no per-run account or currency choice in the browser, and every
   company always able to transact in its own base currency.

