---
name: Money movement idempotency & the single customer payment dialog
description: All settlement RPCs take a caller-derived request key; RecordCustomerPaymentDialog is the only customer money-in surface
type: feature
---

## Single money-in surface
`src/components/payments/RecordCustomerPaymentDialog.tsx` is the ONLY customer
payment recording component. The two former dialogs
(`src/components/invoices/RecordPaymentDialog.tsx`,
`src/components/sales/RecordPaymentDialog.tsx`) are deleted — never recreate
either. All pages (`Invoices`, `CustomerPayments`, `sales/Collections`,
`finance/AccountsReceivable`) import the unified dialog.

## Request keys
`payments.client_request_id` and `bill_payments.client_request_id` each carry a
partial unique index on `(organization_id, client_request_id)`. Every
settlement RPC accepts and replays on a key:
`record_multi_invoice_payment`, `record_payment_atomic`,
`record_advance_payment`, `record_multi_bill_payment`,
`record_vendor_advance_payment`, `apply_vendor_advance_atomic`,
`apply_customer_deposit_atomic`.

Keys MUST be derived from the payment intent — `crypto.randomUUID()` is banned
because a retry mints a new key and posts a second payment. Use
`makeCustomerPaymentRequestId` for AR; batch/import paths derive from a stable
row identity (e.g. `migration:payments:<fileHash>-<rowIndex>`,
`pos:<txnId>:<tenderIndex>`).

## Guards
- `src/test/architecture/money-movement-request-key.test.ts` — every call site
  passes a key; no random keys.
- `src/test/architecture/payment-reversal-intent-contract.test.ts` — exactly one
  customer payment dialog.
