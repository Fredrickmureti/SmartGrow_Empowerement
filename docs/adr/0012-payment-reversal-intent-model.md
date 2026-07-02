# ADR 0012 — Payment reversal intent model

## Status
Accepted — 2026-05-17

## Context
Customer payment reversal previously had two operations exposed by
`useTransactionReversal`:

- `voidPayment` — full GL reversal, no intent captured.
- `unreconcilePayment` — also a full GL reversal but additionally cleared
  `invoice_id` so callers thought the payment was "available again". The
  cash side was already gone; the residue was a confusing zero-effect row.

`voidInvoice` accepted a single `createCreditNote: boolean` that silently
decided "the customer's money becomes store credit" — without asking the
operator whether the customer actually wanted credit, a refund, or to
leave the cash as an advance.

Two unrelated `RecordPaymentDialog` components had drifted (sales 702 LOC
vs invoices 555 LOC). `useCustomerCredit` (credit-limit) and
`useCustomerCredits` (credit-notes) shared overlapping names but
modelled different concepts.

There was no GL home for "money received but not yet applied". Unapplied
cash had to either sit on AR (wrong) or be reversed away (lossy).

## Decision
Adopt the canonical operations used by Odoo / SAP / NetSuite / Dynamics /
ERPNext:

1. **Operations are distinct and never conflated:**
   - `record_payment` — receive cash.
   - `apply_payment` — split outstanding → AR.
   - `unapply_payment` — free AR offset only, keep cash side.
   - `void_payment` — full GL reversal, terminal.
   - `refund_customer` — pay cash out against an outstanding payment or
     credit note.
   - `issue_credit_note` — independent AR credit document.

2. **Business intent is mandatory on every reversal.** The new enum
   `payment_reversal_reason` deterministically maps to one of
   {void, unapply, refund, credit_note}. The operator picks the intent
   from a plain-language list; the system picks the GL path. Enum values:
   - `data_entry_error` → void
   - `duplicate_payment` → void
   - `bank_transfer_failed` → void
   - `wrong_invoice_applied` → unapply
   - `customer_refund_requested` → refund
   - `invoice_cancelled_keep_as_credit` → credit_note
   - `invoice_cancelled_keep_as_advance` → unapply (stays as outstanding)

3. **GL primitive: Customer Deposits** (liability, NetSuite / SAP style).
   Unapplied customer cash lives here, not in AR or Cash. The project
   already exposes this via `default_account_settings.setting_key =
   'customer_deposits'` and `useDefaultAccounts().customer_deposits_id`.
   Migration P1a auto-seeds the account (`2210-1 Customer Deposits`,
   `detail_type='customer_deposits'`) for every business that doesn't
   already have one. The earlier ADR draft mis-classified this as an
   asset called "Outstanding Receipts"; corrected here — unapplied
   customer cash is a liability (we owe goods/services or a refund).

4. **New columns on `payments`:**
   - `outstanding_amount` — cash received but not yet applied to an invoice.
   - `applied_amount` — cash already settled against an invoice.
   - Invariant: `amount = outstanding_amount + applied_amount` (enforced
     by trigger).

5. **Reversal events are append-only.** Every reversal writes a
   `payment_reversal_events` row capturing reason, operator, GL impact,
   and the resulting reversal JE id. The original `payments` row is
   never overwritten.

6. **Customer refunds are first-class.** New `customer_refunds` table
   ties an outbound cash JE back to either a payment or credit note.

7. **One `RecordPaymentDialog`.** The sales-side dialog is canonical;
   the invoices-side duplicate is deleted. An architecture test forbids
   re-introduction.

8. **Closed-period policy.** Reversals into a closed fiscal period are
   forbidden; the wizard forces the operator to pick a reversal date in
   the current open period. This matches Dynamics 365 and is stricter
   than NetSuite by design (no period-override switch in V1).

9. **Advance vs. credit note.** An "advance" stays on the `payments`
   row with `outstanding_amount > 0`; we do NOT introduce a
   `customer_deposits` table. Credit notes remain a separate document.

## Out of scope (this ADR)
- Multi-currency FX revaluation on reversal.
- POS receipt void/refund (its own subsystem).
- AP-side (`voidBill`, `voidBillPayment`) — will adopt the same model in
  a follow-up ADR.
- Bank reconciliation rule changes.

## Invariants enforced by migration / triggers / tests
1. `payments.amount = outstanding_amount + applied_amount` always.
2. Every `void_payment` / `unapply_payment` call records a
   `payment_reversal_events` row with non-null `reason_code`.
3. The `RecordPaymentDialog` exists in exactly one location.
4. `void_journal_entry_atomic` is only called from
   `useTransactionReversal` or `useVoidJournalEntry`.
5. Every business has a `customer_deposits` mapping in
   `default_account_settings`, pointing at a liability account with
   `detail_type='customer_deposits'`.
6. `payments.invoice_id` flips automatically recompute the amount split
   (trigger `recompute_payment_split_on_invoice_flip`); the invariant
   cannot be bypassed by direct UPDATEs.
7. Reversal RPCs must call `public.is_period_open(business_id, date)`
   before posting.

## References
- `src/test/architecture/payment-reversal-intent-contract.test.ts`
- Migration `…_payment_reversal_intent_model.sql`
- `src/hooks/useTransactionReversal.ts`