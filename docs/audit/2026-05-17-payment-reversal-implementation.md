# Payment Reversal Implementation Audit — 2026-05-17

## Scope

Independent re-audit of the previous agent's ADR 0012 work (payment
reversal intent model + Customer Deposits GL primitive), plus completion
of the remaining stages (P1c – P5).

## Verdict on inherited work

- **P1a (intent model schema)** — verified. Enum, columns, trigger,
  events + refunds tables, customer_deposits seed, idempotency index,
  permissive `is_period_open` helper all present and behave as documented.
- **P1b (atomic RPCs)** — verified. `record_payment_reversal_event`,
  `unapply_payment_atomic`, `refund_customer_atomic` all `SECURITY
  DEFINER`, row-locked via `FOR UPDATE`, idempotent on
  `(payment_id, op, client_request_id)`, period-guarded via
  `is_period_open`, posted through `post_journal_entry_atomic`. Invoice
  `amount_paid` and `status` are restored correctly on unapply.
- **Hook layer** — `useTransactionReversal` exposes `unapplyPayment` and
  `refundCustomer` with the right shape; `voidPayment` accepts a reason
  code; audit-log enum extended.

## What I changed in this wave (P1c – P5)

### P1c — Refund hardening + read model
- Migration `…_refund_atomic_hardening`:
  - `customer_refunds.client_request_id` column + partial unique index so
    credit-note-source refunds are also idempotent (previously only
    payment-source short-circuited on replay).
  - `refund_customer_atomic` rewritten to insert the refund row FIRST,
    then post the JE with `source_id = refund.id` so GL drill-down works.
  - Currency is now derived from `businesses.base_currency` (no more
    `'KES'` hardcode).
- New hook `useCustomerOutstandingBalance` — canonical read model
  returning `{ openInvoices, outstandingCash, unappliedCreditNotes,
  netReceivable }`. Sourced from `invoices`, `payments.outstanding_amount`
  (Customer Deposits liability), and `credit_notes`.
- `useCustomerCredit` refactored to consume the new read model so
  credit-limit checks stay aligned with the Customer Deposits GL view.

### P2 — Guided ReversePaymentWizard
- `src/components/payments/ReversePaymentWizard.tsx` (3-step UX):
  1. "What happened?" — radio list of seven plain-language reasons, each
     deterministically mapped to one of {void, unapply, refund,
     credit_note}.
  2. Preview — payment / applied / outstanding figures plus the resolved
     operation. For refunds, picks bank account + amount (capped at
     refundable cash).
  3. Confirm — reversal date + required note. A uuid `client_request_id`
     is generated up-front so retries are idempotent end-to-end.
- `VoidPaymentDialog` is now a thin shell over the wizard so existing
  call sites keep working.

### P3 — Reason-code enforcement (partial)
- `voidPayment` now hard-throws when called without a `reasonCode`
  (previously logged a deprecation warning and silently defaulted to
  `data_entry_error`). UI must mount the wizard.
- Architecture test extended (`payment-reversal-intent-contract.test.ts`)
  to ban any direct call to `voidPayment` / `unapplyPayment` /
  `refundCustomer` from outside `useTransactionReversal` and the wizard.

### P5 — Docs
- This file.

## What I rejected from the inherited plan

- **"Update `get_control_account_reconciliation` to exclude
  `payments.outstanding_amount`."** Verified the RPC: AR sub-ledger total
  is computed from `invoices` only, never from payment outstanding
  amounts. Unapply posts CR AR (reducing AR) and DR Customer Deposits
  (a separate liability), so no drift is introduced. No RPC change
  needed.

- **"Delete `src/components/invoices/RecordPaymentDialog.tsx`."** Closer
  read shows the two files are not duplicates: the invoices-side dialog
  drives a single-invoice flow with credit-note application and print
  preview; the sales-side dialog drives multi-invoice allocation.
  Deleting either would regress functionality. The architecture ratchet
  still caps the count at 2 so no third copy can appear.

- **"Shell `UnreconcilePaymentDialog` into the wizard."** Blocked by
  `unreconcile-balance-contract.test.ts` which locks the dialog's
  live-invoice fetch + `Math.max(0, amount_paid - payment.amount)`
  clamp. The wizard already routes through `unapply_payment_atomic`
  (which applies the same clamp on the server), so the dialog is
  redundant from a correctness standpoint — but its replacement is now
  out of scope until the contract test can be migrated to assert against
  the wizard. Tracked as a follow-up.

- **"Remove the duplicate `record_payment_reversal_event` call from
  `voidPayment`."** Verified: `voidPayment` calls `reverseJEAtomic` (not
  `unapply_payment_atomic`), which does NOT log a reversal event. The
  hook's secondary `record_payment_reversal_event` call is the only
  logger. No duplicate exists.

## Known limitations / follow-ups

1. **`is_period_open` is permissive-default.** Wired into every reversal
   RPC so the guard activates the moment `fiscal_periods` lands. To
   activate, replace the body with:
   ```sql
   SELECT NOT EXISTS (
     SELECT 1 FROM public.fiscal_periods fp
     WHERE fp.business_id = _business_id
       AND _date BETWEEN fp.start_date AND fp.end_date
       AND fp.status = 'closed'
   );
   ```
2. **Backfill collapsed legacy partials.** Historical partial
   reconciliations were forced to `applied = amount, outstanding = 0`
   by the P1a backfill. `useCustomerOutstandingBalance` carries a
   TODO; a corrective query will need source data to reconstruct true
   splits. Tracked as a follow-up.
3. **AP-side mirror.** `voidBill` / `voidBillPayment` retain the
   pre-ADR shape. ADR 0013 will mirror this model on the AP side.
4. **`UnreconcilePaymentDialog` consolidation.** See "rejected" §3 above.
5. **Per-invoice `payment_applications` table.** Today, multi-invoice
   apply is collapsed into a single payment row. A future ADR will
   model per-invoice splits.
6. **Multi-currency FX revaluation on reversal.** Out of scope.

## How to verify locally

- `bun run test --filter payment-reversal-intent-contract` — architecture ratchets.
- Open a customer payment, click Void → wizard launches; pick a reason
  → preview shows correct GL operation; confirm posts the right JE.
- Refund a customer with `outstanding_amount = 0` and an applied
  invoice → wizard auto-unapplies before refunding.