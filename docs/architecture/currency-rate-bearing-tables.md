# Rate-bearing tables — stamping register (Phase 9.3 / 9.5)

Every table that stores an exchange rate is in exactly one of the two lists
below. The architecture test `src/test/architecture/currency-ratchet.test.ts`
parses this file, so a new rate column must be registered here or CI fails.

Invariants behind both lists:

- The rate is resolved **server-side** from the rate book (`resolve_exchange_rate`
  / `require_exchange_rate` / `fx_stamp_document`). No write path accepts a rate
  from the client.
- A missing rate is an **absence**, never parity. `1` appears only when the
  document currency equals the company base currency.
- Once the document is posted, the currency and the rate are **immutable**.

## Stamped — foreign-currency accounting events

Table | Stamping trigger | Immutability
--- | --- | ---
`invoices` | `trg_invoices_stamp_currency` | posted invoice
`bills` | `trg_bills_stamp_currency` | posted bill
`bill_payments` | `trg_bill_payments_stamp_currency` | posted payment
`credit_notes` | `trg_credit_notes_stamp_currency` | posted credit note
`vendor_credit_notes` | `trg_vcn_stamp_currency` | posted note
`customer_refunds` | `trg_customer_refunds_stamp_currency` | posted refund
`purchase_orders` | `trg_po_stamp_currency` | posted order
`purchase_returns` | `trg_purchase_returns_stamp_currency` | posted return
`sales_orders` | `trg_sales_orders_stamp_currency` | posted order
`estimates` | `trg_estimates_stamp_currency` | posted estimate
`rfq_quotations` | `trg_rfq_quotations_stamp_currency` | posted quotation
`bank_transactions` | `trg_bank_transactions_stamp_currency` | reconciled line
`fixed_assets` | `trg_fixed_assets_stamp_currency` | capitalised asset
`landed_cost_vouchers` | `trg_lc_vouchers_fx_stamp` | posted voucher
`expenses` | `trg_expenses_base_amount` (stamps via `require_exchange_rate`) + `trg_expenses_a_fx_immutable` | approved or paid expense
`project_cost_entries` | `trg_project_cost_entries_stamp_currency` | rate always re-derived server-side; absence preserved
`project_revenue_entries` | `trg_project_revenue_entries_stamp_currency` | rate always re-derived server-side; absence preserved

### Notes on the Phase 9.3 additions

- **`expenses`** — a foreign-currency accounting event. The rate was already
  stamped by `_expenses_derive_base_amount` (which also refuses a currency that
  is not enabled for the company); what was missing was posted-immutability, now
  enforced by `_tg_expenses_fx_immutable`. The guard trigger is named to sort
  before the derive trigger so it inspects the values the caller actually sent.
- **`project_cost_entries` / `project_revenue_entries`** — writable directly by
  project financial managers, not only through `upsert_project_cost` /
  `upsert_project_revenue`, so the rate must be server-owned on every path.
  `_tg_stamp_project_entry_currency` recomputes `currency`, `base_currency`,
  `fx_rate` and `amount_base` on every insert and update and discards any
  client-supplied rate. When no rate is on file, `fx_rate` and `amount_base`
  both stay `NULL`; the check constraints
  `project_{cost,revenue}_entries_rate_absence_ck` make the paired absence
  structural.

## Base-currency-only or rate-fixed by construction

Table | Rate column | Why no stamping trigger
--- | --- | ---
`pos_payment_sessions` | `fx_rate` | The rate is resolved once by `pos_payment_session_open`, which refuses a caller-supplied `p_fx_rate` (ADR 0136) and only supports settling into the company base currency. It is fixed for the life of the session and enforced by `trg_pos_sessions_a_fx_immutable`; there is no later write path that could change the currency, so a stamping trigger would have nothing to stamp.
`fx_revaluation_lines` | `old_rate`, `new_rate` | Historical evidence of a posted revaluation run, written only by `revalue_fx_balances`. Rows are append-only and must never be re-stamped.
`exchange_rates` | `rate` | This *is* the rate book. Rows are immutable once published; writes are finance-manager gated.
`journal_entry_lines` | `original_*` | Amounts are stamped by the posting engine from the source document's already-stamped rate; a second stamping would re-open a posted period.
