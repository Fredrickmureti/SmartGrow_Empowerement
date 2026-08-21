# Currency & FX — engine trust wave (live status)

## Verdict on the contract

**Is the centralized FX engine receiving trustworthy, complete, correctly-denominated
data from every producer?** Not fully, before this wave. Three defects were confirmed
against the live database:

- F1 — `revalue_fx_balances` accepted the reporting currency from the caller and never
  compared it with `businesses.base_currency`.
- F2 — unrealized gain/loss accounts were picked per run in the browser, while realized
  FX used a central resolver. Two runs could hit two different P&L accounts.
- F4 — the FX control panel exposed a free-text base-currency box and account pickers.

Cleared on inspection:

- F3 — `resolve_sales_exchange_rate` is a one-line delegation to
  `resolve_exchange_rate`. It is an alias, not a second engine. No change needed.

## Done in this wave

1. `system_account_roles` + `account_role_eligibility` now carry `fx_unrealized_gain`
   and `fx_unrealized_loss`, mirroring the realized pair.
2. New `resolve_fx_account(business_id, purpose)` — one resolution order for all four FX
   P&L roles: Default Accounts mapping → legacy `default_accounts.purpose` → eligibility
   catalogue → name heuristic → raise. `resolve_fx_realized_account` now delegates to it
   (it previously read only the empty `default_accounts` table and fell straight to a name
   guess), and `resolve_fx_unrealized_account` is its unrealized twin.
3. `revalue_fx_balances` derives the reporting currency from `businesses.base_currency`,
   rejects a mismatched caller value, and resolves both FX accounts server-side; a
   caller-supplied account that differs from the mapping raises instead of being used.
4. Client: `useFxRevaluation.runRevaluation` takes only a run date. The control panel shows
   the entity's reporting currency read-only and states where the FX accounts come from.
5. FX accounts (realized and unrealized) are now mappable in Settings → Default Accounts.
6. Guards added to `src/test/architecture/fx-single-engine.test.ts` — the browser may not
   send `_base_currency` or either `_unrealized_*_account`, and the panel may not offer a
   free-text currency or per-run account pickers.

## Open

- **Step 4 GL tie-out is unproven for lack of data**, not failing: no tenant has a posted
  journal line on a realized FX account yet, so realized-report vs GL is 0 = 0. Re-run the
  tie-out once a foreign-currency settlement exists.
- Step 5 — exposure dimensions (by counterparty, by ageing bucket) on
  `fx_exposure_by_currency` / `fx_exposure_open_items`.
- `business_active_currencies` is enforced by the expense trigger but still unpopulated;
  a currency-enablement UI must seed it with the base currency.
