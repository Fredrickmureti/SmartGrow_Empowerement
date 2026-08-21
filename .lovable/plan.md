# Currency & Forex — reporting trustworthiness programme

Authoritative status file. Update after every implementation step.

## Where we are

- Step 0 — FX surface lockdown: **COMPLETE**
- Step 1 — Denomination contract safe by construction: **COMPLETE, behaviourally verified**
- Step 2 — Producer families migrated: **COMPLETE for the currency-bearing callers**
- Step 3 — Monetary eligibility + line-level currency: **COMPLETE, verified**
- Step 4 — Realized FX gain/loss report: **NEXT (active phase)**
- Steps 5–6 (exposure dimensions, rate provenance surface): pending

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

## Step 3 — Monetary eligibility (next)

`revalue_fx_balances` currently selects exposure with an `asset OR liability`
rule, which sweeps in inventory, fixed assets, prepayments and deferred revenue.
Drive eligibility from `account_detail_type_catalog` (monetary detail types
only) and group exposure by line-level `original_currency` rather than the
header currency. No new schema needed.

## Steps 4–6

Realized FX gain/loss report; exposure by account and counterparty; rate
register / provenance surface.

## Notes for the next agent

1. Settlement paths (`record_multi_invoice_payment`, `record_multi_bill_payment`,
   `bank_match_confirm`) already do their own base/foreign handling — do **not**
   flip them blindly; confirm line denomination first.
2. Migrate call sites by patching `pg_get_functiondef` output inside the
   migration, never by retyping a function body.
3. Behavioural probes: wrap in a `DO` block that ends with `RAISE EXCEPTION`
   so the transaction rolls back; the message carries the results.
