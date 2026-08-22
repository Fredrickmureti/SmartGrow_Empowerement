# Currency & FX — authoritative status (handover verified 2026-08-22)

Authority: ADR 0135 / 0136 / 0138. Scope boundary: FX source → settlement →
posting → FX engine → FX reporting. No second rate table, no second resolver,
no client-side conversion that posts, no unrelated module work.

## Handover verification of the previous engineer's claims (this wave)

VERIFIED FACT (live catalogue + code reads, 2026-08-22):

- **Phase 12a (AP aggregates) — GENUINELY DONE.** `get_ap_summary`,
  `get_ap_aging_summary`, `finance_ap_aging_reconciliation` and
  `finance_ap_reconciliation_detail` all return `unconvertible_document_count`
  and wrap every base-currency total in
  `CASE WHEN COUNT(*) FILTER (WHERE base_* IS NULL) > 0 THEN NULL ELSE SUM(...)`.
  The residual `COALESCE(SUM(...),0)` text inside them is inside that guard, so
  it is not the Phase 12 defect. `get_ar_summary` carries the same guard.
- **Phase 12b (USD literals) — DONE.** No `'USD'` literal remains in
  `finance_ap_open_items_as_of`, `finance_ar_open_items_as_of` or
  `finance_ap_vendor_credit_as_of`.
- **Phase 12c (client) — DONE.** `src/services/finance/openItems.ts` types
  `base_residual_amount: number | null` and now `continue`s on null at lines
  312, 384, 675; the `?? r.residual_amount` silent-1:1 fallbacks are gone.
- **Phase 12d (AP UI) — DONE.** `src/components/finance/BaseCurrencyAmount.tsx`
  exists; `useApSummary`, `useApAging`, `useApReconciliation`, `AgedPayables`,
  `ApReconciliation`, `Bills` all carry the unconvertible state.
- **Phase 11 — re-confirmed** by the existing catalogue ratchets.

INVALIDATED / CORRECTED CLAIMS:

- The log calls the remaining work "Phase 12e (AR-side UI parity)". That is
  understated: the AR gap is **SQL-side as well as UI-side**.
  VERIFIED FACT: `finance_ar_aging_reconciliation` still computes
  `COALESCE(SUM(o.base_residual_amount), 0)` and
  `COALESCE(SUM(c.base_credit_amount), 0)` with **no absence guard and no
  unconvertible count**. An unconvertible foreign invoice silently drops out of
  the aging side while remaining in the `ar_subledger_entries` control balance —
  the reconciliation reports a *fabricated variance* (or, worse, an apparent
  tie-out) rather than declaring the absence. This is the AR twin of the exact
  defect Phase 12a fixed on AP.
- The earlier plan's "12e" numbering was also used for the ratchet task. The
  ratchet (`fx_open_items_absence_test.sql` AP extension + client guard) is
  **not yet confirmed present** for the AP aggregates — UNVERIFIED, must be
  checked and completed.
- Phase 14 premise partially INVALIDATED: `src/components/settings/CurrencySettings.tsx`
  already selects currencies from the catalogue (`Select` over the currencies
  table) for base currency, active currencies and the manual override form —
  currency is **not** typed free-hand there. The parent prompt's complaint must
  be re-scoped to the `/finance/settings` → Accounting Controls → FX tab and to
  whether override/provider precedence is explained on screen. UNVERIFIED which
  surface, if any, still free-types a currency.

## Remaining work, in dependency order

### Phase 13 — AR absence parity (SQL, root)  ← START HERE
- `finance_ar_aging_reconciliation`: null the aging and credit totals when any
  contributing row is unconvertible, add `unconvertible_document_count` to the
  return type, mirroring `finance_ap_aging_reconciliation`.
- Verify `get_ar_ap_aging_from_ledger` and `finance_ar_customer_credit_as_of`
  for the same pattern before changing them (neither reports an unconvertible
  count today; establish whether they can produce one).
- One migration per function — never batched.

### Phase 14 — AR client + UI parity
- `src/services/finance/aging.ts`, `useAgingReport.ts`, `useCustomerStatements.ts`:
  carry the nullable base amount and the unconvertible count through instead of
  coercing.
- Aged Receivables / Collections / customer statements render via the existing
  `BaseCurrencyAmount`. No new renderer.

### Phase 15 — ratchets
- Extend `supabase/tests/fx_open_items_absence_test.sql`: every
  `finance_a[pr]_*` / `get_a[pr]_*` aggregate that sums a `base_*` column must
  carry an absence guard and expose an unconvertible count.
- Vitest architecture guard forbidding `base_*_amount ?? <foreign amount>` in
  `src/services/finance/**`.

### Phase 16 — `finance_open_items_tieout`
The only `finance_*` view still holding a currency literal, currently exempted
in the ratchet. Decide whether the literal is diagnostic-only; if not, remove it
and drop the exemption.

### Phase 17 — FX settings surface audit (re-scoped)
Audit `FinanceAccountingControls.tsx` (FX tab) and `ExchangeRatePanel.tsx`:
confirm no free-typed currency remains, and that override > manual > provider
precedence and provenance (`source`, `provider_key`, `published_at`) are shown
where a rate is displayed. Reuse existing components only.

## Carried limitations (documented, not defects)
- `payments` / `customer_credit_balances` carry no currency column: advances are
  structurally base-currency only. Schema change out of scope without a decision.
- Live `exchange_rates` holds base-currency rows only, so foreign paths are
  proven by catalogue tests and construction, not by exercised tenant data.
- `.sql` suites under `supabase/tests/` cannot be executed from this environment;
  their catalogue assertions are re-run as read-only SELECTs.
- Pre-existing unrelated failure: `bill-payment-allocations-first-class.test.ts`.
- Supabase binding is `jkszmrroyjfdwokbkzis`. Connecting `AccrualFlowCorporation`
  would be a destructive re-bind and stays out of scope.

## Scope boundaries
No changes to the resolver, the rate book, stamping, settlement or revaluation —
verified correct in earlier waves. No new views, no second aggregation path, no
client-side rate maths.

## Tests required
`fx-single-engine`, `fx-tenant-isolation`, `currency-integrity`,
`ap-aging-scenario-fixtures`, `aging-single-source`,
`reports-data-source-contract`, plus the new Phase 15 guards; `tsgo --noEmit`
clean after each nullable type change.
