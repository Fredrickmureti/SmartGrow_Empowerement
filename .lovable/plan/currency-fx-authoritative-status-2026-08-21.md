# Currency & FX — authoritative status

Authority: ADR 0135 / 0136 / 0138. Scope boundary: FX source → settlement →
posting → FX engine → FX reporting. No second rate table, no second resolver,
no client-side conversion that posts, no unrelated module work.

## Completed and verified

### Phases 1–8 (earlier waves)
One rate book (`public.exchange_rates`), one server resolver
(`resolve_exchange_rate` / `require_exchange_rate`), one client lookup
(`@/services/fx/rateBook`). Booking, settlement, compensation and POS paths all
refuse a missing rate instead of posting at parity.

### Phase 9 — reversal symmetry — DONE
- `void_journal_entry_atomic` carries `original_currency` / `exchange_rate` onto
  reversal lines, mirrors `original_debit` / `original_credit` to the opposite
  side; the reversal header inherits the original currency + rate.
- `unapply_payment_atomic` mirrors the original settlement journal line-for-line
  (cash leg reclassified to customer deposits). No rate is re-resolved on a
  reversal.
- AP reversals (`void_payment_atomic`, `void_bill_payment_atomic`,
  `unapply_vendor_credit_from_bill_atomic`) delegate to
  `void_journal_entry_atomic`; no duplicate reversal engine exists.
- Ratchet: `supabase/tests/fx_reversal_symmetry_test.sql`.

### Phase 10 — honest absence in the AR open-item projections — DONE
- `finance_ar_open_items`: parity fallback and `'USD'` literal removed;
  `base_residual_amount` is NULL for a foreign document with no stamped rate.
- `finance_ar_net_position_by_currency`: base columns NULL when any contributing
  document is unconvertible, plus `unconvertible_document_count`.
- `raise_ar_dispute` / `record_promise_to_pay`: `'KES'` literals removed,
  currency derived from the business base currency, writes refuse without one.
- Client: Collections renders "No rate on file" instead of a coerced 0.
- Ratchet: `supabase/tests/fx_open_items_absence_test.sql`.

### Phase 11 — FX tenant isolation ratchet — DONE — RE-VERIFIED THIS WAVE
VERIFIED FACT (live catalogue, this wave):
`resolve_exchange_rate`, `require_exchange_rate`, `resolve_sales_exchange_rate`,
`fx_stamp_document`, `_pick_exchange_rate_row`, `reverse_fx_revaluation_run`
all show `authenticated=false, anon=false`; `describe_exchange_rate` retains
`authenticated=true`. `bunx vitest run fx-tenant-isolation + fx-single-engine`:
34/34 pass. Phase 11 is genuinely closed.

## Active phase

### Phase 12 — AP-side absence parity (IN PROGRESS)

Investigation results (all VERIFIED FACT, read from live function bodies and
`src/services/finance/openItems.ts` this wave):

1. `finance_ap_open_items_as_of` and `finance_ar_open_items_as_of` are already
   rate-honest at row level: document snapshot rate → identity for a
   same-currency document → `resolve_exchange_rate`, else NULL, and
   `base_residual_amount = residual * rate` propagates the NULL. The Phase 12
   premise "the AP row projection fabricates a parity rate" is INVALIDATED.
   No `COALESCE(...,1)` exists in either.

2. **The real defect is one layer up — absence is destroyed by the aggregates.**
   `get_ap_summary`, `get_ap_aging_summary`, `finance_ap_aging_reconciliation`
   and `finance_ap_reconciliation_detail` all use
   `COALESCE(SUM(o.base_residual_amount), 0)`. SQL `SUM` skips NULLs, so an
   unconvertible foreign bill silently drops out and an **understated** payable
   total is presented as complete. This is the exact class Phase 10 fixed for
   the AR net-position view, unfixed on the AP side.
   ACCOUNTING CONSEQUENCE: understated liabilities, aging buckets that do not
   tie to the AP control account, and a reconciliation report that reports a
   clean tie-out while omitting the item causing the break.

3. **A second, opposite-signed defect on the client.**
   `src/services/finance/openItems.ts` lines 307, 377, 666 read
   `Number(r.base_residual_amount ?? r.residual_amount)`. When the base amount
   is absent the FOREIGN amount is added into a base-currency total — a silent
   1:1, forbidden by ADR 0136. Affects top-payables exposure, contact statement
   aging (AR and AP), and the `fetchPayableCounterparties` cohort that drives
   vendor statement runs and payment sweeps. The same file already handles
   `base_credit_amount === null` correctly, so the omission is inconsistent, not
   deliberate. `ApOpenItemAsOfRow.base_residual_amount` is typed `number`, which
   hid it from the type checker; the engine can return null.

4. Residual currency literals: `finance_ap_open_items_as_of`,
   `finance_ap_vendor_credit_as_of` and `finance_ar_open_items_as_of` still
   carry `COALESCE(..., 'USD')` as a last-resort currency when
   `businesses.base_currency` is null. Lower severity than 2/3 (a business
   without a base currency is already misconfigured) but it is a fabricated
   denomination and must become a refusal.

5. `finance_ap_vendor_credit_as_of` is already correct — it nulls
   `base_credit_amount` when any component is unconvertible. Leave it alone
   apart from the `'USD'` literal.

Work, in dependency order:
- **12a (SQL, root)** — teach the four AP aggregates to distinguish absence
  from zero: return `NULL` for a base-currency total when any contributing row
  has `base_residual_amount IS NULL`, and expose
  `unconvertible_document_count` alongside, mirroring
  `finance_ar_net_position_by_currency`. Same treatment for `get_ar_summary`
  where it shares the pattern (verify before changing).
- **12b (SQL)** — replace the `'USD'` fallbacks in the three `*_as_of`
  functions with a raise/NULL denomination; a business with no base currency
  must not silently report in USD.
- **12c (client)** — type `base_residual_amount` as `number | null`; delete the
  three `?? r.residual_amount` fallbacks; skip unconvertible rows from
  base-currency sums and carry a count out of each helper.
- **12d (UI)** — Aged Payables, AP summary tiles, vendor statements and the
  payables cohort screens render the absence state ("N documents have no rate
  on file", linking to `/settings/company?tab=currency`) instead of a confident
  number, matching Collections.
- **12e (ratchet)** — extend `supabase/tests/fx_open_items_absence_test.sql`
  with the AP aggregates (no bare `COALESCE(SUM(base_*),0)` in a `finance_*` /
  `get_a[pr]_*` aggregate; an unconvertible count must exist) and add a
  client-side guard forbidding `base_*_amount ?? <foreign amount>` in
  `src/services/finance/**`.

## Pending

### Phase 13 — `finance_open_items_tieout`
The only `finance_*` view still holding a currency literal; currently exempted
in the ratchet. Decide whether the literal is diagnostic-only and remove the
exemption.

### Phase 14 — FX settings surface (from the parent prompt, not yet actioned)
The parent prompt calls out `/finance/settings` → Accounting Controls → FX:
currency is typed free-hand instead of being chosen from the catalogue as
landed cost does (`CurrencyCombobox` + `useCurrencies`), and the override /
provider-rate precedence is not explained in the UI. Audit
`FinanceAccountingControls.tsx` and `ExchangeRatePanel.tsx` against the
landed-cost pattern; reuse the existing components, do not build new ones.
UNVERIFIED — not yet inspected this wave.

## Carried limitations (documented, not defects)
- `payments` / `customer_credit_balances` carry no currency column: advances are
  structurally base-currency only. Schema change out of scope without a decision.
- Live `exchange_rates` holds base-currency rows only, so foreign paths are
  proven by catalogue tests and construction, not by exercised tenant data.
- The `.sql` suites under `supabase/tests/` cannot be executed from this
  environment (SELECT-only tooling); their catalogue assertions are re-run as
  read-only SELECTs. The DML fixtures inside them remain UNVERIFIED.
- Pre-existing unrelated failure: `bill-payment-allocations-first-class.test.ts`.
- Supabase binding is `jkszmrroyjfdwokbkzis`; connecting a different project
  (`AccrualFlowCorporation`) would be a destructive re-bind and is out of scope
  for this wave.

## Tests required for Phase 12
- Extended `supabase/tests/fx_open_items_absence_test.sql` (catalogue, read-only).
- New/extended vitest architecture guard for the client fallback pattern.
- Re-run `fx-single-engine`, `fx-tenant-isolation`, `currency-integrity`,
  `ap-aging-scenario-fixtures`, `aging-single-source`, `reports-data-source-contract`.
- `tsgo --noEmit` must stay clean after the nullable type change (it will surface
  every remaining unhandled null — that is the point).

## Scope boundaries
No changes to the resolver, the rate book, stamping, settlement or revaluation
in Phase 12 — they are verified correct. No new views, no second aggregation
path, no client-side rate maths.
