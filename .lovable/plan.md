# Currency & Forex — reporting trustworthiness programme

Authoritative status file. Update after every implementation step.

## Where we are

- Step 0 — FX surface lockdown: **COMPLETE**
- Step 1 — Denomination contract safe by construction: **COMPLETE, behaviourally verified**
- Step 2 — Producer families migrated: **COMPLETE for the currency-bearing callers**
- Step 3 — Monetary eligibility + line-level currency: **COMPLETE, verified**
- Step 4 — Realized FX gain/loss report: **COMPLETE (RPC + hook + page + guard)**
- Step 5 — Exposure dimensions (by account, by counterparty): **NEXT (active phase)**
- Step 6 — Rate register / provenance surface: pending


---

## Step 0 — Lockdown (done)

`anon` EXECUTE revoked across the FX function surface; `describe_exchange_rate`
now gates on `user_can_access_business`.

## Step 1 — The posting engine is the denomination authority (done)

`post_journal_entry_atomic` treats `_amounts_in_document_currency` as tri-state:

- `NULL` + foreign `_currency` → **raises**. A foreign entry can no longer slip
  into the ledger at parity because a caller forgot to declare itself.
- `true` → lines are document amounts; the engine resolves the rate through
  `require_exchange_rate` (missing rate raises, never 1:1), writes base
  `debit`/`credit`, stamps `original_currency` / `original_debit` /
  `original_credit` / `exchange_rate`, validates balance in both denominations
  and absorbs the rounding residual on the largest line. Per-line `currency`
  is honoured, so mixed-currency entries convert line by line.
- `false` → amounts are already base; behaviour byte-identical to before.

**Behavioural verification** (run in a transaction that was rolled back, org
`8e68…`, USD 129.5 / EUR 140.76):

| probe | result |
| --- | --- |
| foreign entry, no declaration | raised ✔ |
| USD 1000 declared | base 129 500.00, `original_currency=USD`, `original_debit=1000`, rate 129.5 ✔ |
| mixed USD/EUR lines | each line converted, entry balanced in base ✔ |
| base-currency entry | unchanged, no `original_*` stamped ✔ |
| CHF (no rate on file) | raised ✔ |

No probe rows remained afterwards (`journal_entries where source_type='fx_probe'` = 0).

## Step 2 — Producer families (done)

Each migrated by surgically patching `pg_get_functiondef`, with a hard failure
if the call site did not match:

- AP bills — `confirm_bill_atomic` now passes `bills.currency` +
  `bills.currency_rate` + the opt-in (previously passed **no** currency at all,
  so every foreign bill entered the ledger at face value).
- Credit notes — `issue_credit_note_atomic`, `issue_vendor_credit_note_atomic`
  (document rate + opt-in).
- Refunds — `refund_customer_atomic`, `refund_from_vendor_atomic` (opt-in, rate
  resolved by the engine at the posting date).
- Credit application — `apply_credit_to_invoice_atomic`.
- Repair utilities — `post_missing_invoice_journals`,
  `repair_misposted_ar_invoices`.
- Correction: `complete_delivery_atomic` passed the customer's document
  currency onto **cost** lines that are already base. It now passes `NULL`.

Remaining callers pass no currency and post base amounts; the engine's Step 1
guard now makes any future foreign posting without a declaration impossible.

Guard: `supabase/tests/journal_denomination_contract_test.sql` — one engine
overload, opt-in defaults to false, undeclared-foreign refusal, `original_*`
stamping, resolver use, base-balance assertion, residual absorption, no rate
literal, no anon EXECUTE, per-family denomination declarations, and the delivery
COGS base-currency assertion.

## Step 3 — Monetary eligibility + line-level currency (done)

The old scope rule was `a.account_type IN ('asset','liability')`, which swept
inventory, fixed assets, prepayments and deferred revenue into revaluation —
IAS 21 requires those to stay at their historical rate.

- New single classifier `public.fx_is_monetary_account(account_type, detail_type)`
  — `IMMUTABLE`, `search_path` pinned, EXECUTE revoked from PUBLIC/`anon`,
  granted to `authenticated` + `service_role`. It excludes 34 non-monetary
  detail types and treats a NULL detail type as monetary so an unclassified
  receivable/payable is never silently dropped.
- `revalue_fx_balances`, `fx_exposure_by_currency` and `fx_exposure_open_items`
  all use it, so the summary, the drill-down and the posting engine agree on
  scope. The drill-down previously used the old rule and disagreed with the
  summary it drills into.
- All three now key on `COALESCE(jel.original_currency, je.currency)`, so a
  mixed-currency entry is measured per line instead of by the header.

Verified: classifier truth table (`AR=t INV=f fixed_asset=f AP=t
deferred_revenue=f NULL=t income=f`, 34 catalog rows excluded), run in a
rolled-back transaction. Guard: section 6 of
`supabase/tests/fx_revaluation_lifecycle_test.sql` fails if any FX surface
returns to the asset-or-liability rule or to header-currency grouping.

## Step 4 — Realized FX gain/loss report (done)

Realized FX is posted at settlement by `record_multi_invoice_payment` /
`record_multi_bill_payment` (ADR 0123 posting monopoly). Step 4 adds the report
as a **projection of what those postings actually put in the ledger** — no
second computation.

Landed:

- **Pre-work (safety sweep).** The Step 1 guard would have rejected nine legacy
  callers that pass a foreign currency without declaring denomination. Patched:
  `_landed_cost_post_apply`, `landed_cost_reverse_voucher`,
  `expense_reimburse_direct`, `bank_match_confirm`,
  `bank_reconciliation_session_complete`, `bank_reconciliation_session_writeoff`,
  `record_multi_bill_payment`, `record_multi_invoice_payment` → explicit
  `false` (they compute base themselves); `_bank_account_post_opening_balance`
  → `true` (needs engine conversion). Confirmed via `pg_proc` that no
  currency-bearing caller is left undeclared.
- **`public.fx_realized_gain_loss(_business_id uuid, _from date, _to date)`** —
  SECURITY DEFINER, gated on `user_can_access_business`, EXECUTE revoked from
  PUBLIC/`anon`, granted to `authenticated` + `service_role`. Finds journal
  lines hitting the accounts returned by `resolve_fx_realized_account`, so the
  report cannot disagree with the GL. Returns `jsonb`: `base_currency`,
  `from`, `to`, `accounts_configured`, `settlements[]` (entry, date, source,
  party, currency, settled foreign amount, booked rate, settlement rate, booked
  base, realized amount, gain/loss kind), `by_currency[]`, `total_gain`,
  `total_loss`, `net_realized`.
- **`src/hooks/finance/useFxRealized.ts`** — thin React Query reader over the
  RPC, business-scoped, no client-side rate work.
- **`src/pages/reports/FxRealizedReport.tsx`** at
  `/finance/reports/fx-realized` — KPIs, by-currency summary, settlement detail
  with journal-entry links, XLSX export, and an explicit alert when the realized
  FX accounts are unmapped (`accounts_configured = false`) instead of silently
  reporting zero.
- Registered in `ReportRegistry` (`fx-realized`, statutory) and under
  Reports → Currency & FX in `reportsNav`; lazy route in `src/apps/finance/routes.tsx`.
- Guard: new section in `src/test/architecture/fx-single-engine.test.ts` —
  the hook and page must not touch `exchange_rates` / `journal_entry_lines`,
  must not use `rateBook`, and must not fall back to `1`. 20/20 tests pass.

## Steps 5–6 (pending)

5. **Exposure dimensions (active next)** — exposure by GL account and by
   counterparty, reusing `fx_is_monetary_account` and the existing open-item
   scope of `revalue_fx_balances`; extend `fx_exposure_*` rather than adding a
   third scope rule.
6. Rate register / provenance surface — the rate book with `source`,
   `provider_key`, `published_at` and effective date, plus server-validated
   override entry.

## Instructions for the next agent

**Verify before you build.** Confirm Step 4 landed correctly and to
enterprise standard before opening Step 5:

1. `select count(*) from pg_proc where proname='fx_realized_gain_loss'` = 1;
   it is SECURITY DEFINER, calls `user_can_access_business`, and `anon` has no
   EXECUTE.
2. Its numbers tie to the GL: for a period, the sum of `realized_amount` must
   equal the net movement on the accounts `resolve_fx_realized_account` returns.
   Prove it with a read-only query, not by reasoning.
3. `supabase/tests/fx_revaluation_lifecycle_test.sql` and
   `supabase/tests/journal_denomination_contract_test.sql` still run clean, and
   `bunx vitest run src/test/architecture/fx-single-engine.test.ts` passes.
4. Still outstanding from Step 2 and worth doing first for end-to-end proof:
   post one real foreign bill and one foreign credit note in a scratch business,
   settle one at a different rate, and confirm the realized figure appears in
   this report with the right sign.

**Then resume at Step 5** — exposure dimensions. Do not skip to Step 6 and do
not open unrelated areas of the system.

Working rules that have held so far:

1. Settlement paths (`record_multi_invoice_payment`, `record_multi_bill_payment`,
   `bank_match_confirm`) do their own base/foreign handling and now declare
   `_amounts_in_document_currency := false` explicitly — do not flip them.
2. Migrate call sites by patching `pg_get_functiondef` output inside the
   migration (with a hard `RAISE` when the fragment does not match), never by
   retyping a function body.
3. Behavioural probes: wrap them in a `DO` block that ends with
   `RAISE EXCEPTION` so the transaction rolls back and the message carries the
   results — never leave probe rows in a tenant's ledger.
4. One scope rule, one resolver, one posting engine. Any new FX surface reuses
   `fx_is_monetary_account`, `resolve_exchange_rate`/`require_exchange_rate` and
   `post_journal_entry_atomic` — never a second implementation.
5. Reporting surfaces are projections: the browser formats, the server resolves.


