# FX Foundation & Source-Consumption — controlled rework wave

Authoritative execution memory. Status vocabulary: VERIFIED / PARTIALLY VERIFIED /
IMPLEMENTED BUT NOT ACCOUNTING-VERIFIED / BLOCKED / NOT YET INVESTIGATED.
Supersedes the "Currency & Forex reporting trustworthiness" status file; reporting
(Phases 3–5 of that plan) is out of scope for this wave.

## Verdict (from live database inspection, this session)

**Partially sound at the centre, fundamentally deficient at the boundary.**
The rate book, the resolver pair and the posting engine's conversion path exist and
are structurally correct. But only **1 of 53** journal-posting callers actually uses
the conversion path, the opt-in is silently unsafe, revaluation eligibility is the
simplistic `asset OR liability` rule, and realized FX exists on two settlement paths
out of many. No foreign-currency journal has ever been posted in this database
(0 rows), so nothing about the foundation has been accounting-verified — only
catalog-verified.

## Verified facts (live DB, not the previous plan)

- `post_journal_entry_atomic` — exactly one overload, ends with
  `_amounts_in_document_currency boolean DEFAULT false`. When opted in it resolves via
  `require_exchange_rate`, converts, stamps `original_currency/original_debit/
  original_credit/exchange_rate`, validates balance in document **and** base currency,
  absorbs the rounding residual on the largest line, stamps header currency+rate.
  **VERIFIED structurally.**
- Callers: **53** functions call the engine. **Exactly one** (`_confirm_invoice_core`)
  opts in. Nine pass a document `_currency` (+ rate) **without** opting in —
  `issue_credit_note_atomic`, `issue_vendor_credit_note_atomic`,
  `issue_credit_note_for_payment_atomic`, `complete_delivery_atomic`,
  `refund_customer_atomic`, `refund_from_vendor_atomic`, `approve_sales_return_atomic`,
  `apply_credit_to_invoice_atomic`, `bank_match_confirm`, plus
  `post_missing_invoice_journals`/`repair_misposted_ar_invoices`. These label the entry
  foreign and record the amounts unconverted. **VERIFIED defect.**
- `confirm_bill_atomic` passes no `_currency` at all — a foreign bill is recorded as
  base with no trace. **VERIFIED defect.**
- Engine trusts a caller-supplied `_exchange_rate` over the resolver when one is passed.
  **VERIFIED.**
- `revalue_fx_balances` groups by **header** `je.currency` (not line
  `original_currency`), falls back to `jel.debit/credit` when `original_*` is NULL, and
  filters eligibility with `a.account_type IN ('asset','liability')`. Missing rate now
  fails the run loudly. **VERIFIED — eligibility and grouping are wrong.**
- `reverse_fx_revaluation_run` no longer references `reversal_of_run_id` and scopes to
  `_run.organization_id`. **VERIFIED structurally; 0 runs exist, so never exercised.**
- Realized FX: `resolve_fx_realized_account` is referenced by exactly
  `record_multi_invoice_payment` and `record_multi_bill_payment`. Nothing else.
  **VERIFIED.**
- Multi-tenant: `fx_stamp_document`, `describe_exchange_rate`,
  `resolve_fx_realized_account` and **`set_exchange_rate_override`** carry `anon=X`
  EXECUTE. `resolve_exchange_rate` / `require_exchange_rate` / exposure RPCs do not.
  **VERIFIED — grant leak, override write is the serious one.**
- `resolve_sales_exchange_rate` is a one-line delegate to `resolve_exchange_rate` — not
  a second engine. Client side has no conversion outside `rateBook`/`platformUsd`
  (platform billing display). **VERIFIED.**
- Data: 130 exchange rates, 0 stamped lines, 0 foreign journal headers, 0 revaluation
  runs. **VERIFIED — no production FX data at risk; migrations need no backfill.**
- `accounts.detail_type` + `account_detail_type_catalog` (≈180 detail types incl.
  `accounts_receivable`, `accounts_payable`, `inventory`, `prepaid_expenses`,
  `customer_deposits`, `security_deposits`, fixed-asset types) already carry the
  semantics needed for monetary classification. **No Chart-of-Accounts field needs
  adding.** VERIFIED.

## Accounting model this wave enforces (IAS 21)

Transaction date: record at the spot rate; base amount is authoritative in the GL, the
foreign amount is carried as line metadata. Monetary items: retranslate at closing rate
each period (unrealized), retranslate at settlement (realized) — the realized amount is
the difference between the carrying base amount at derecognition and the cash base
amount. Non-monetary items measured at historical cost (inventory, fixed assets,
prepayments, deferred revenue) are **not** retranslated. Missing rate is an absence and
must raise, never post at parity. Reversal restores the original base amounts unchanged.

## FX source → posting map (to be completed in Step 3; UNKNOWN = not yet traced)

| Family | Posting path | Currency passed | Opt-in | Realized FX | Status |
|---|---|---|---|---|---|
| AR invoice | `_confirm_invoice_core` | yes | yes | n/a | IMPLEMENTED, NOT ACCOUNTING-VERIFIED |
| AP bill | `confirm_bill_atomic` | **no** | no | n/a | DEFECTIVE |
| Credit note (AR/AP) | `issue_credit_note_atomic`, `issue_vendor_credit_note_atomic` | yes | **no** | none | DEFECTIVE |
| Delivery / GRN / landed cost | `complete_delivery_atomic`, `finance_post_gr_journal`, `_landed_cost_post_apply` | mixed | no | n/a | DEFECTIVE / non-monetary review |
| Customer receipt | `record_multi_invoice_payment` | no | no | yes | PARTIALLY VERIFIED |
| Supplier payment | `record_multi_bill_payment` | no | no | yes | PARTIALLY VERIFIED |
| Advances | `record_advance_payment`, `apply_customer_deposit_atomic`, `record_vendor_advance_payment`, `apply_vendor_advance_atomic` | no | no | none | DEFECTIVE |
| Refunds | `refund_customer_atomic`, `refund_from_vendor_atomic` | yes | no | none | DEFECTIVE |
| Bank match / reconciliation | `bank_match_confirm`, `bank_reconciliation_session_complete/_writeoff` | partial | no | none | UNKNOWN |
| Unapply / reversal / void | `unapply_payment_atomic`, `unreconcile_payment_atomic`, `void_journal_entry_atomic` | no | no | n/a | UNKNOWN |
| POS, payroll, expenses, inventory adjustments | various | no | no | n/a | assumed base-only — to confirm, not to migrate |

## Work, in dependency order

### Step 0 — Close the two security holes (immediate, tiny)
Revoke `anon` EXECUTE from `set_exchange_rate_override`, `fx_stamp_document`,
`describe_exchange_rate`, `resolve_fx_realized_account`; confirm each gates on
`user_can_access_business` for the passed business id rather than trusting the argument.

### Step 1 — Make the denomination contract safe by construction
Replace the silent boolean with an engine that cannot be misused: when `_currency`
resolves to a non-base currency the engine **must** convert; a caller wanting to supply
already-converted base amounts states that explicitly. Concretely — keep one engine,
invert the default so an unconverted foreign posting raises instead of passing, and stop
preferring a caller-supplied rate over the resolver except for an explicitly stamped
document rate. Line-level `original_currency` becomes the authority for denomination
(header currency stays a convenience mirror) so mixed-currency entries are representable.

### Step 2 — Producer families, one at a time
Order: AP bills → credit notes (AR then AP) → refunds → advances → delivery/GRN/landed
cost (deciding non-monetary treatment per IAS 21) → bank match/reconciliation. Each
family: trace it, migrate it, add an accounting-outcome test, verify reversal, verify
tenant isolation, then move on. No half-migrations.

### Step 3 — Realized FX across every derecognition path
Extend beyond the two multi-payment functions: partial and multiple settlements,
advance application, credit-note application, refunds, write-offs, payment reversal /
unapply, bank-match settlement. One shared realized-FX helper consuming
`resolve_fx_realized_account` — no per-module variants.

### Step 4 — Monetary eligibility
Replace `account_type IN ('asset','liability')` with a `detail_type`-driven monetary
classification (data-driven map over the existing catalog, no new columns), and group
revaluation by line `original_currency` rather than header currency, dropping the
`COALESCE(original_debit, debit)` fallback that would revalue base amounts.

### Step 5 — Revaluation lifecycle, exercised for real
With correct sources, run the lifecycle end to end in a scratch business: run,
second-period run, reversal, reversal-then-run, locked period, missing rate, nil
movement, settlement after revaluation. Assert no accumulation across runs.

### Step 6 — Ratchets and hand-off
Extend `supabase/tests/journal_denomination_contract_test.sql` and
`src/test/architecture/fx-single-engine.test.ts`: no caller may pass a foreign
`_currency` without conversion, no rate literal, no second resolver, no anon EXECUTE on
FX functions, no `COALESCE(..., 1)` rate fallback. Reporting work is the **next** wave.

## Tests required (accounting assertions, not "function ran")
Foreign invoice USD 1,000 @ 130 → AR base 130,000, line stamped USD/1,000; settled
@ 132 → realized loss/gain 2,000 and AR clears to zero; partial settlement proportional;
missing rate raises; reversal restores exactly; mixed-currency journal balances in both
denominations; non-monetary inventory line excluded from revaluation; a Business B user
cannot read or revalue Business A.

## Open at hand-off
Nothing requires a user decision. Every item above is determinable from the code, the
database, or IAS 21.
