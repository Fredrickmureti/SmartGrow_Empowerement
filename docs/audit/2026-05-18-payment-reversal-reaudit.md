# Payment Reversal Re-audit — 2026-05-18

Independent re-verification of the previous agent's ADR 0012 claims, plus
the first wave of corrective work (R1, R3, R4-partial). See
`.lovable/plan.md` for the full plan.

## Verified true
- Schema + atomic RPCs (`record_payment_reversal_event`, `unapply_payment_atomic`, `refund_customer_atomic`) — present and correctly shaped.
- `ReversePaymentWizard` 3-step UX — present.
- `voidPayment` hard-throws without `reasonCode` — verified.
- `useCustomerOutstandingBalance` read model + `useCustomerCredit` refactor — present.
- Refund hardening (currency from `businesses.base_currency`, `source_id=refund.id`, `customer_refunds.client_request_id` unique idx) — verified in migrations.

## Verified false (now fixed in this wave)

1. **"Keep as credit note" was a lie.** The wizard's
   `invoice_cancelled_keep_as_credit` reason routed through `voidPayment`,
   which never inserted a `credit_notes` row. **Fix shipped:** new RPC
   `issue_credit_note_for_payment_atomic` + hook
   `useTransactionReversal.issueCreditNoteForPayment` + wizard now routes
   the `credit_note` op to it. The RPC unapplies any current invoice
   application (DR Customer Deposits / CR AR), inserts a `credit_notes`
   row with new `source_payment_id` column, and records a
   `payment_reversal_events` row with `op='credit_note'`. Idempotent on
   `client_request_id`.

2. **Pre-refund auto-unapply used the wrong reason code** (`wrong_invoice_applied`).
   **Fix shipped:** new enum value `pre_refund_unapply`; wizard now uses
   it for the synthetic unapply.

## Verified false (still pending, tracked)

3. **`UnreconcilePaymentDialog` still mounted in `CustomerPayments.tsx`
   and `PaymentHistoryDialog.tsx`** — bypasses the wizard, calls the
   legacy `unreconcilePayment` path that reverses the cash receipt JE
   instead of parking on Customer Deposits. Two divergent accounting
   outcomes coexist. **Status: NOT YET FIXED.** Needs Wave R2.

4. **No customer-deposit application UI.** RPC
   `apply_customer_deposit_atomic` shipped, but the
   `ApplyCustomerDepositDialog` and `useCustomerUnappliedDeposits` hook
   are not yet built. **Status: RPC ready, UI pending.**

5. **Refund cap still permits refunding currently-applied cash with a
   silent full unapply.** **Status: NOT YET FIXED.** Should default to
   `outstandingAmount` only and require an explicit operator
   acknowledgement before raising the cap.

6. **No cross-currency refund guard.** Enum value
   `payment_currency_mismatch` reserved; runtime guard not yet wired.

7. **AP-side mirror missing** — voidBill / voidBillPayment unchanged.
   Tracked as ADR 0013 (not started).

## Verified true (no change needed, contrary to inherited plan)

- `get_control_account_reconciliation` AR sub-ledger already excludes
  payment outstanding — re-verified.
- `voidPayment` does NOT double-log reversal events — re-verified.

## What shipped in this turn

- **Migration** adding:
  - `payment_reversal_reason` values `pre_refund_unapply`, `payment_currency_mismatch`.
  - `payment_reversal_events.op` check accepts `credit_note`, `apply_deposit`.
  - `credit_notes.source_payment_id` + index.
  - `issue_credit_note_for_payment_atomic(_payment_id, _reason_text, _reversal_date, _client_request_id)`.
  - `apply_customer_deposit_atomic(_payment_id, _invoice_id, _amount, _apply_date, _client_request_id)`.
  - Partial unique indexes for idempotency on the two new op kinds.
- **Hook surface** (`src/hooks/useTransactionReversal.ts`):
  - `PaymentReversalReason` extended with `pre_refund_unapply`, `payment_currency_mismatch`.
  - New methods `issueCreditNoteForPayment`, `applyCustomerDeposit`.
- **Audit log** (`src/hooks/useAuditLog.ts`): added `credit_note_issued`, `deposit_applied`.
- **Wizard** (`src/components/payments/ReversePaymentWizard.tsx`):
  - `credit_note` op now calls the new RPC (no longer silently voids).
  - Pre-refund auto-unapply uses `pre_refund_unapply` reason code.

## Outstanding follow-ups (next turn)

In priority order:

1. **R2** — Delete `UnreconcilePaymentDialog`, migrate
   `unreconcile-balance-contract.test.ts` into the wizard contract test,
   swap mounts in `CustomerPayments.tsx` + `PaymentHistoryDialog.tsx`,
   remove `unreconcilePayment` from the public hook surface, extend
   `payment-reversal-intent-contract.test.ts` to ban re-introduction.
2. **R3 UI** — `ApplyCustomerDepositDialog` + `useCustomerUnappliedDeposits`
   surfaced from the customer ledger / unapplied-payments list.
3. **R4** — Tighten refund cap, add cross-currency guard, hoist
   `clientRequestId` to a stable per-payment key.
4. **R6** — ADR 0013 stub + AP-side mirror.
5. **Update `mem://features/payment-reversal`** with the deposit-
   application + credit-note primitives once R2/R3 UI lands.

## Known limitations

- `is_period_open` remains permissive-default (no `fiscal_periods` table).
  Reversal RPCs are wired for the guard to activate automatically once
  the period table lands; no flag is needed.
- Multi-invoice payment splits remain unrepresentable
  (deferred ADR 0014).
- FX revaluation on reversal is out of scope (deferred ADR 0015).
