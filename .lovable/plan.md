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

## Currently active phase

None in flight — Phase D closed cleanly. Nothing is half-built.

## Pending, in the order it should be taken

1. **Step 6 — `business_active_currencies` enablement (next).** The expense trigger already
   validates against this table and the table is empty across the install, so the gate is
   inert today and will start rejecting expenses the instant anyone inserts a single row.
   Needs: a server-side seed of the base currency for every existing business, an
   enablement UI in Settings → Currency writing through an RPC (never a direct table
   write), and a guard that the base currency can never be deactivated.
2. **Step 7 — realized-FX GL tie-out proof.** Unprovable today for lack of data, not
   failing: no tenant has a posted journal line on a realized FX account, so
   realized-report vs GL is 0 = 0. Re-run the tie-out once a foreign-currency settlement
   exists, and add it as a SQL test under `supabase/tests/`.
3. **Step 8 — period-close interlock.** A period should not close while
   `fx_exposure_by_currency` reports a currency with no rate on file.

## Instructions for the next agent

1. **Verify before continuing.** Do not trust this file. Confirm in the live database that
   `resolve_fx_account`, `resolve_fx_unrealized_account` and `fx_exposure_dimensions` exist
   with the bodies described, that `revalue_fx_balances` raises on a caller-supplied
   currency that differs from `businesses.base_currency`, and that
   `EXECUTE` on each is granted to `authenticated` only. Then run
   `bunx vitest run src/test/architecture/fx-single-engine.test.ts` (expect 24 passing) and
   `bunx tsgo --noEmit -p tsconfig.app.json`.
2. **Then resume at Step 6**, not at unrelated work. Bring it to a production-ready state —
   migration, seed, RPC, UI and guard together — before opening Step 7.
3. Keep the invariants: one rate book, one resolver, server-side booking rates, missing rate
   renders as an absence, and no per-run account or currency choice in the browser.
