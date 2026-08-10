---
name: AP funding account split
description: Treasury bank_accounts ids vs GL accounts ids in vendor payments; record_multi_bill_payment parameters, AP idempotency key, dialog fallback
type: feature
---

# AP funding account: treasury vs GL (ADR 0129)

- `bank_accounts.id` (treasury instrument) and `accounts.id` (GL account) are
  **different id spaces**. Never pass one where the other is expected.
- `record_multi_bill_payment` takes both:
  - `_bank_account_id` — optional treasury id, stored on the `bill_payments` header.
  - `_credit_account_id` — GL account the journal credits (required, resolvable).
  If only a treasury id is given, the GL account is resolved from
  `bank_accounts.account_id`; a treasury row with no GL mapping errors loudly.
- `useBills.recordMultiBillPayment` resolves the GL cash account from default
  account mappings (`cash_account_id`) and MUST forward it as `_credit_account_id`.
- Payment is still rejected when no funding account resolves — the fix supplies
  the account, it does not weaken the invariant.
- The bill payment dialog shows a read-only "Paid from — default Cash / Bank
  ledger account" line when `bank_accounts` is empty, instead of hiding the field.
- AP idempotency: `makeVendorPaymentRequestId` (vendor + sorted allocation
  fingerprint + total cents + date), mirroring `makeCustomerPaymentRequestId`.
- Ratchets: `src/test/architecture/ap-funding-account-split.test.ts` and the
  wrapper-caller check in `money-movement-request-key.test.ts`.
- Domain boundaries stay separate: instruction (dialog) → execution + allocation
  (settlement RPC) → GL posting (`post_journal_entry_atomic`) → reconciliation
  (downstream, never mints payments) → reversal (`void_bill_payment_atomic`).
