# ADR 0129 — AP funding account: treasury instrument vs GL account

Status: Accepted
Date: 2026-08-10

## Context

A KES 7,000 supplier payment failed with HTTP 400 from
`record_multi_bill_payment`. The server error was
`Bank/cash account is required for multi-bill payment.`

Two defects produced it:

1. `RecordBillPaymentDialog` only rendered the funding-account selector when
   `bank_accounts` had rows. That table was empty, so the dialog sent `null`.
   `useBills.recordMultiBillPayment` resolved and validated a GL cash account
   from the default account mappings and then discarded it.
2. More seriously, `_bank_account_id` served two incompatible roles inside the
   RPC: it was written to `bill_payments.bank_account_id`
   (`REFERENCES bank_accounts(id)` — a treasury instrument) *and* used as the
   `account_id` of the credit line handed to `post_journal_entry_atomic`
   (`accounts(id)` — a GL account). Had a bank account existed, the journal
   would have referenced an id from the wrong table.

AR never had this conflation: `payments.deposit_account_id` FKs to
`accounts(id)`, and the treasury link is established downstream at bank
reconciliation.

## Decision

1. **Two ids, two parameters.** `record_multi_bill_payment` takes
   `_bank_account_id` (treasury, optional, stored on the payment header only)
   and `_credit_account_id` (GL, the account the journal credits).
2. **Resolution order.** If `_credit_account_id` is absent and a treasury id is
   given, the GL account is resolved from `bank_accounts.account_id`; a treasury
   row with no GL mapping raises a clear, actionable error. Legacy callers that
   passed a GL account through `_bank_account_id` are still honoured.
3. **The invariant stands.** A payment with no resolvable funding account is
   still rejected. The fix supplies the account; it does not weaken the check.
4. **The client supplies inputs, never accounting truth.** The dialog collects
   vendor, date, method, allocations and (optionally) the treasury account. The
   GL accounts come from default account mappings, and every amount, balance and
   status is re-derived server-side under `FOR UPDATE`.
5. **AP money-out is idempotent from the UI.** `makeVendorPaymentRequestId`
   mirrors `makeCustomerPaymentRequestId`: the key is derived from the payment
   intent (vendor, sorted allocation fingerprint, total, date) and never from a
   random source.

## Ownership (unchanged, restated)

| Concern | Owner |
| --- | --- |
| Payment header (identity, method, date, currency) | `bill_payments` / `payments` |
| AP allocation | `bill_payment_allocations` via `record_multi_bill_payment` |
| AR allocation | `payment_allocations` via `record_multi_invoice_payment` |
| GL posting | `post_journal_entry_atomic` — sole writer (ADR 0123) |
| Cash/bank instrument | `bank_accounts`, linked to a GL account |
| Reconciliation | bank reconciliation engine, strictly downstream of payment |
| Reversal | `void_bill_payment_atomic` / `void_payment_atomic` (ADR 0126) |
| Idempotency | `client_request_id` on the settlement header |

AR and AP remain **separate domain commands over shared infrastructure**. They
are not merged into one RPC, and reconciliation is not merged into payment
recording.

## Consequences

- Vendor payments work with or without treasury rows configured.
- A bank account without a GL mapping fails loudly at payment time with a
  message that names the fix, instead of minting a broken journal line.
- `src/test/architecture/ap-funding-account-split.test.ts` fails CI if a client
  ever routes a `bank_accounts` id into a GL account parameter.
- `money-movement-request-key.test.ts` now also fails CI when a UI calls a
  settlement hook wrapper without a request key.
