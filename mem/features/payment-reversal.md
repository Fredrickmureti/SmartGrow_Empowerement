---
name: Payment reversal architecture
description: ADR 0012 intent model — wizard, atomic RPCs, Customer Deposits GL primitive, deposit-apply + credit-note primitives
type: feature
---

## Rule
Every payment reversal in the UI MUST mount `ReversePaymentWizard`
(`src/components/payments/ReversePaymentWizard.tsx`). The wizard
collects a `payment_reversal_reason` from a plain-language radio list
and maps it deterministically to one of:
  - `void`        — full reversal, terminal.
  - `unapply`     — release AR, keep cash as Customer Deposit advance.
  - `refund`      — pay customer back out of a bank account.
  - `credit_note` — issue a credit note via `issue_credit_note_for_payment_atomic`.

## Apply unapplied deposits
Cash sitting on Customer Deposits (`payments.outstanding_amount > 0`)
is consumed via `ApplyCustomerDepositDialog`
(`src/components/payments/ApplyCustomerDepositDialog.tsx`) which wraps
`useTransactionReversal().applyCustomerDeposit` →
`apply_customer_deposit_atomic`. Never write to AR directly to
"settle" a deposit. Surface the dialog from any view that has a
`contactId` via the optional `onApplyDeposit` prop on
`PaymentListTable`. `useCustomerUnappliedDeposits(contactId)` is the
read model.

## Refund rules (ADR 0012 R4)
- Default refund cap = `payment.outstanding_amount`. Raising it
  requires the operator to tick **"Also free cash from the linked
  invoice"** in the wizard — silent pre-refund unapply is banned.
- Cross-currency refunds (bank account currency ≠ business base
  currency) are blocked at the wizard level until ADR 0015 lands.
- `clientRequestId` is derived deterministically from
  `payment.id + reasonCode + amountCents + bankAccountId` so a
  double-click cannot double-spend.

## Service layer
Reversal hooks live in `src/hooks/useTransactionReversal.ts`:
  - `voidPayment({ reasonCode, … })` — hard throws if `reasonCode` is
    missing.
  - `unapplyPayment({ reasonCode, … })` — wraps `unapply_payment_atomic`.
  - `refundCustomer({ source, sourceId, bankAccountId, amount, … })` —
    wraps `refund_customer_atomic`.
  - `issueCreditNoteForPayment(...)` — wraps `issue_credit_note_for_payment_atomic`.
  - `applyCustomerDeposit(...)` — wraps `apply_customer_deposit_atomic`.
All accept `clientRequestId` for end-to-end idempotency.
`unreconcilePayment` is intentionally NOT exposed on the public
surface (ADR 0012 Wave R2) — use the wizard's `wrong_invoice_applied`
path instead.

## DB primitives
- `payment_reversal_events` — append-only audit log; sole writer is
  `record_payment_reversal_event`.
- `customer_refunds` — XOR on `source_payment_id` vs `source_credit_note_id`;
  idempotent via `client_request_id` unique index.
- `payments.outstanding_amount` + `payments.applied_amount` — split
  invariant enforced by `enforce_payment_amount_split` trigger.
- Unapplied customer cash maps to the Customer Deposits liability
  account (`default_account_settings.setting_key = 'customer_deposits'`),
  seeded for every business.
- `is_period_open(business_id, date)` already queries
  `public.fiscal_periods` and returns false for any date inside a
  `is_closed=true` row — no feature flag required.

## Read model
`useCustomerOutstandingBalance(contactId)` is the single source of
truth for customer receivable position. `useCustomerCredit` consumes
it; never recompute from invoices directly in new code.

## Architecture guard
`src/test/architecture/payment-reversal-intent-contract.test.ts` bans:
- direct calls to `voidPayment` / `unapplyPayment` / `refundCustomer`
  from outside `useTransactionReversal` + `ReversePaymentWizard`,
- re-introducing `UnreconcilePaymentDialog`,
- any UI call to the internal `unreconcilePayment`.
