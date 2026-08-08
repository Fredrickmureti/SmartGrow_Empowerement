---
name: Open items & invoice payability
description: finance_ar/ap_open_items must net credit-note applications; payability derives from residual, not status label; 'sent' is the only post-confirm invoice status
type: feature
---

## Open-items projections
`finance_ar_open_items` / `finance_ap_open_items` are the only source of
receivable/payable figures, and their `applied_amount` MUST net **every**
settlement channel:

- AR: non-voided `payment_allocations` + `credit_note_applications`
  (excluding draft/cancelled/voided credit notes).
- AP: `bill_payment_allocations` + `vendor_credit_note_applications`.

Terminal-settled documents (`paid`, `void*`, `cancelled`, `draft`) are excluded
outright. `finance_open_items_tieout` compares projection residual against the
AR/AP subledger net per business — non-zero `drift` is a bug, not noise.

## Invoice payability
`src/services/finance/invoicePayability.ts` is the single source:
`isInvoicePayable` / `isInvoiceOverdue` (residual-based) and
`fetchOpenCustomerInvoices` (reads `finance_ar_open_items`). Never gate a
payment surface on a hand-written status array.

## Invoice status vocabulary
`'sent'` is the only post-confirmation open status. `confirm_invoice_atomic`
is the single writer (called with `p_final_status: 'sent'`); the recurring
engine `generate_recurring_invoice_occurrence` writes `'sent'` too. No
client-side status overwrite after confirmation.

## Guards
- `supabase/tests/open_items_settlement_channels_test.sql`
- `src/test/architecture/invoice-payability-single-source.test.ts`
