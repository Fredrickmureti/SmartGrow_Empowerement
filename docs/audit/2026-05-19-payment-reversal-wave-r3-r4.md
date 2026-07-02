# Payment Reversal — Wave R3 + R4 audit  (2026-05-19)

Independent re-verification of ADR 0012 progress, plus shipment of the
next two waves on the inherited plan (R3 customer-deposit application
UI, R4 refund correctness).

## What I re-verified (no change)

- ADR 0012 Wave R2 is real (deletions + ratchet tests present).
- `applyCustomerDeposit` hook method and `apply_customer_deposit_atomic`
  RPC are present and correctly shaped.
- `issueCreditNoteForPayment` and `pre_refund_unapply` are correctly
  wired in `ReversePaymentWizard`.
- `is_period_open(business_id, date)` already queries
  `public.fiscal_periods` and returns `false` for any date that falls
  inside a `is_closed = true` row — **no `enforce_period_close` flag is
  needed**. The original Wave R5 design predates the discovery that the
  function is already active; documenting here so a future agent does
  not re-propose the flag.

## Wave R3 — Customer Deposits application UI  (shipped)

### New hook — `src/hooks/useCustomerUnappliedDeposits.ts`
Single source of truth for "payments with unapplied cash on Customer
Deposits". Queries `payments` filtered to the active org + business,
`outstanding_amount > 0`, `status != 'voided'`. Returns `deposits`,
`totalUnapplied`, `isLoading`, `refetch`. Optional `contactId` scope
for the per-customer surfaces. 15s `staleTime` to match
`useCustomerOutstandingBalance`.

### New dialog — `src/components/payments/ApplyCustomerDepositDialog.tsx`
Three-section dialog scoped to a single `contactId`:

1. **Deposit picker** — auto-selects when exactly one unapplied deposit
   exists; otherwise shows receipt number + date + outstanding amount.
2. **Open invoice picker** — only invoices in `sent | viewed | partial |
   overdue` with non-zero balance. (Currency filter intentionally
   omitted — `payments` and `invoices` have no `currency` column;
   `business.base_currency` is uniform per business. When ADR 0015
   introduces multi-currency lines, this dialog gates on a currency
   match.)
3. **Amount + date + preview** — amount hard-clamped to
   `min(deposit.outstanding_amount, invoice.balance)`. Preview block
   renders the literal GL movement (`DR Accounts Receivable / CR
   Customer Deposits`) at the operator's chosen amount, plus the
   resulting invoice balance and remaining deposit.

Confirm calls
`useTransactionReversal().applyCustomerDeposit(...)` with a
deterministic `clientRequestId =
apply-{paymentId}-{invoiceId}-{amountCents}` so a double-click cannot
double-spend. Idempotency is also enforced server-side by the partial
unique index seeded with the RPC.

### Mount points
- `src/components/payments/PaymentListTable.tsx` — new optional
  `onApplyDeposit` prop; new dropdown item **"Apply Deposit to
  Invoice"** appears only when `payment.outstanding_amount > 0`.
- `src/pages/CustomerPayments.tsx` — wires the new prop and mounts
  `ApplyCustomerDepositDialog` with the selected payment's
  `contact_id` + `initialPaymentId`.

On success, the dialog invalidates:
`customer-unapplied-deposits`, `customer-outstanding-balance`,
`invoices`, `invoice(<id>)`, `payments`, `open-invoices-for-deposit`.

### Deferred (low-priority follow-up, not blocking)
- Invoice-detail banner ("Customer has $X unapplied — apply now").
  Single mount point change; not shipped here to keep this wave
  focused. The dialog is reusable from any surface that has a
  `contactId`.

## Wave R4 — Refund correctness  (shipped)

In `src/components/payments/ReversePaymentWizard.tsx`:

### Refund cap is now strict
Default `refundCap = outstandingAmount`. Previously the cap silently
fell back to `payment.amount` when nothing was unapplied, which meant
a full-applied payment could be refunded with the wizard quietly
unapplying the invoice behind the operator's back.

### Explicit acknowledgement to free applied cash
New checkbox **"Also free cash from the linked invoice"** appears on
the refund step whenever `appliedAmount > 0`. Until ticked:
- the refund cap stays at `outstandingAmount`,
- the amount input is disabled with a clear "no cash available"
  message if nothing is unapplied,
- the silent pre-refund unapply branch refuses to run and throws
  `"This refund needs cash that is currently applied to an invoice.
  Tick the acknowledgement first."`.

When ticked, cap rises to `outstandingAmount + appliedAmount` and the
wizard runs `unapply_payment_atomic` (reason `pre_refund_unapply`)
before `refund_customer_atomic` — same two-call sequence as before but
now consented to.

### Cross-currency refund guard
If `bankAccount.currency !== business.base_currency`, the wizard:
- shows the mismatch inline under the bank-account picker,
- disables the **Next** button on step 2,
- throws a hard error at submit time if it ever leaks past the UI
  guard ("Cross-currency refunds are not yet supported …").
Bank accounts in the picker now display their currency next to the
name. ADR 0015 will lift this restriction once FX revaluation lands.

### Deterministic idempotency key
`requestId` was previously generated by `crypto.randomUUID()` on
component mount — surviving a remount but not a remount with a fresh
payload. It is now derived via `useMemo` from
`payment.id + reasonCode + amountCents + bankAccountId`, so two
concurrent submits with identical intent collide on the server-side
unique-index check.

## Wave R5 — already operational (no work needed)

`is_period_open(business_id, date)` already queries
`public.fiscal_periods` and returns `false` for any date inside a
`is_closed=true` row. The earlier plan to add `finance_settings
.enforce_period_close` is moot — the guard activates automatically the
moment a tenant closes a period. Recommended follow-up is a Finance
Settings UI to *manage* fiscal-period rows, not a feature flag.

## Wave R6 — AP-side mirror  (deferred)

`voidBill` / `voidBillPayment` still keep the pre-ADR shape. Mirror
work (Vendor Deposits liability, atomic RPCs,
`ReverseBillPaymentWizard`) tracked as ADR 0013, not started in this
turn.

## Files changed

```text
src/hooks/useCustomerUnappliedDeposits.ts                          new
src/components/payments/ApplyCustomerDepositDialog.tsx             new
src/components/payments/PaymentListTable.tsx                       edit (onApplyDeposit prop + row action)
src/pages/CustomerPayments.tsx                                     edit (mount ApplyCustomerDepositDialog)
src/components/payments/ReversePaymentWizard.tsx                   edit (strict cap, explicit unapply checkbox, currency guard, deterministic requestId)
```

## Verified by

- `tsc --noEmit -p tsconfig.app.json` — clean.
- Architecture contract test
  `payment-reversal-intent-contract.test.ts` still passes:
  the new dialog only calls `applyCustomerDeposit`, not any of the
  banned `void / unapply / refund` triplet.
