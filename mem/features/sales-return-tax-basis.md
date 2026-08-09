---
name: Sales return tax basis & fiscal exit
description: Returns snapshot the original invoice line's tax/discount/eTIMS codes; the credit note is the only fiscal document for a return
type: feature
---

# Sales return tax basis (Phase 8)

**Tax on a return is never recomputed from current product settings.**

- `resolve_sales_return_line_tax(invoice_item_id, qty)` derives, from the source
  `invoice_items` row: net-of-discount unit price, pro-rated `tax_amount` (from the
  line's *stored* tax, so historic rounding is honoured), `tax_rate`,
  `discount_percent`, `etims_tax_code`, `etims_classification_code`.
- `create_sales_return_atomic` calls it for every line with an `invoice_item_id`
  and **ignores client-supplied tax/price** for those lines. Client values are
  used only for manual (non-invoice) lines. `sales_return_items` stores the
  snapshot in `source_tax_rate`, `source_tax_amount`, `source_discount_percent`,
  `etims_*`, and `tax_basis_source` (`invoice_line` | `manual` | `backfilled_invoice_line`).
- Rounding is settled **once per document**: line tax is kept at 6dp, the header
  is rounded to 2dp, and the delta is applied to the largest tax line so output
  tax never drifts.
- `approve_sales_return_atomic` and `create_credit_note_atomic` carry the eTIMS
  codes into `credit_note_items`.

## Fiscal exit — one document per reversal

The sales return is an internal document. `trg_sales_return_fiscal_enqueue` was
dropped: only the **credit note** enqueues a fiscal transmission. A BEFORE INSERT
trigger (`tg_fiscal_transmission_link_original`) stamps
`original_transmission_id` / `original_fiscal_number` on credit-note
transmissions from the invoice's own transmission and mirrors them into
`request_payload`. Do not re-add a return-level fiscal trigger.

The create form's tax figures are a preview only; the server is the authority.
