# Payment Reversal — Wave R7 + R3-followups (2026-05-20)

Independent re-verification of R3/R4 (all claims TRUE per prior audit
`2026-05-19-...`) plus shipment of R7 contract tests and the R3
discoverability follow-ups.

## What shipped this turn

### Wave R7 — regression guards (P1)
Source-grep contract tests in the project's standard architecture-test
pattern. They pin the invariants in source so future agents cannot
silently regress them.

- `src/test/payments/refund-cap-strictness.test.ts` — locks the strict
  cap, the explicit `allowUnapplyForRefund` acknowledgement, the throw
  when the checkbox is not ticked, the `amt > refundCap` rejection, and
  the `pre_refund_unapply` reason code.
- `src/test/payments/refund-currency-guard.test.ts` — locks the
  `currencyMismatch` derivation, the hard throw at submit, and the
  inline UI message.
- `src/test/payments/refund-idempotency.test.ts` — locks the
  deterministic `makeDeterministicRequestId(payment, reason, cents,
  bank)` shape, the `useMemo` dependency tuple, the ban on
  `crypto.randomUUID()`, and the `${requestId}-pre-unapply` derived
  sub-key.
- `src/test/payments/customer-deposits-apply.test.ts` — locks the
  hard clamp `min(deposit.outstanding, invoice.balance)`, the
  deterministic `apply-{paymentId}-{invoiceId}-{cents}` request id, the
  ban on direct void/unapply/refund calls from the dialog, the six
  query-key invalidations on success, and the read-hook filter
  invariants (`outstanding_amount > 0`, `status != voided`,
  org+business scoping).

All 19 tests green.

### R3-followups — discoverability (P2)

- `src/components/invoices/InvoiceDetailDialog.tsx` — new
  unapplied-deposit `<Alert>` banner shown only when both
  `invoice.balance > 0` AND
  `useCustomerUnappliedDeposits(invoice.contact_id).totalUnapplied > 0`.
  "Apply Deposit" button mounts `ApplyCustomerDepositDialog` with
  `initialInvoiceId=invoice.id`; auto-seeds the single deposit when
  exactly one exists.
- `src/pages/reports/PartnerLedger.tsx` — new
  `<PartnerLedgerDepositAction>` sub-component renders an
  "Apply $X" header action per customer row (gated on
  `partnerType === 'customer'` AND `totalUnapplied > 0`). Click opens
  `ApplyCustomerDepositDialog` scoped to that contact. `e.stopPropagation`
  prevents the surrounding `<CollapsibleTrigger>` from toggling.

## What remains (next turn)

- **R6 — AP-side mirror (ADR 0013)**: `voidBill` / `voidBillPayment`
  still keep the pre-ADR shape. Mirror migration + `ReverseBillPaymentWizard`
  + `ApplyVendorDepositDialog` + hook surface + intent-contract ratchet
  extension. This is the only remaining architectural debt from the
  inherited plan.
- **R8 — ADR 0012 doc refresh**: invariants section pre-dates the
  credit-note + deposit-apply + strict-cap + currency-guard primitives.
  Cosmetic; no behavioral impact.

## Verified by

- `bunx vitest run src/test/payments/` — 4 files, 19 tests, all green.
- Grep confirms zero callers of the reversal hook methods outside
  `useTransactionReversal.ts`, `ReversePaymentWizard.tsx`, and
  `ApplyCustomerDepositDialog.tsx` (intent-contract invariant
  preserved by the new mounts).

## Files changed

```text
src/test/payments/refund-cap-strictness.test.ts             new
src/test/payments/refund-currency-guard.test.ts             new
src/test/payments/refund-idempotency.test.ts                new
src/test/payments/customer-deposits-apply.test.ts           new
src/components/invoices/InvoiceDetailDialog.tsx             edit (banner + dialog mount)
src/pages/reports/PartnerLedger.tsx                         edit (per-customer Apply action)
```
