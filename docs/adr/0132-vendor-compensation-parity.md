# ADR 0132 — Vendor (AP) Compensation Parity

Status: Accepted
Date: 2026-08-07

## Context

ADR 0131 fixed the AR side of compensation: one writer per act, a customer
credit subledger, a dedicated liability account, business-scoped numbering and
server-built journal lines. The AP side kept the architecture ADR 0131 removed:

- `confirm_vendor_credit_note_atomic` posted a flat `Dr AP / Cr Expense` entry
  regardless of whether the linked bill was still open, so a credit against a
  settled bill reduced a payable that no longer existed.
- There was no vendor credit ledger. Availability was derived from
  `vendor_credit_notes.total - amount_applied`, which the GL cannot reconcile.
- `apply_vendor_credit_note_atomic` allocated across bills without touching the
  ledger, and `usePurchaseReturns.ts` inserted a vendor credit note header from
  the browser and then built its journal lines client-side
  (`postPurchaseReturnGL`).

## Decision

The AP side mirrors ADR 0131, term for term.

1. **One writer per compensation act.** `create_vendor_credit_note_atomic`
   (header, lines and business-scoped number in one transaction),
   `issue_vendor_credit_note_atomic`, `apply_vendor_credit_to_bill_atomic`,
   `apply_vendor_credit_fifo_atomic` (server-side FIFO allocation over the
   single-bill writer), `refund_from_vendor_atomic`. Posting remains exclusively
   through `post_journal_entry_atomic` (ADR 0123).
2. **Issuing decides the counter-leg server-side.** AP is reduced only up to the
   linked bill's still-open balance; any remainder becomes **vendor credit**.
3. **Vendor credit is an asset with its own ledger.**
   `vendor_credit_balances` is a projection of append-only
   `vendor_credit_movements` (`issue`, `apply`, `refund`, `expire`). Availability
   is read from the balance, never from document columns. Balances may not go
   negative.
4. **Its own GL account.** The `vendor_credit` system account role
   (`1215 Vendor Credits`, provisioned per business through
   `upsert_system_account`) keeps vendor credit out of Accounts Payable, so
   `vendor_credit_tieout` can compare the subledger with the GL account exactly
   as `customer_credit_tieout` does. Drift is recorded by
   `snapshot_control_account_drift()`.
5. **Legacy writers are retired, not deprecated.**
   `confirm_vendor_credit_note_atomic` and `apply_vendor_credit_note_atomic` are
   dropped; there is no fallback path.
6. **No client-side compensation accounting.** The browser does not insert
   vendor credit note headers, allocate a number, choose bills, resolve GL
   accounts or build journal lines. `postPurchaseReturnGL` is deleted.

## Consequences

- A purchase return, a vendor credit note and a vendor refund all reconcile
  against one account and one subledger, and are traceable
  bill → credit note → movement → refund → journal entry → bank.
- `vendor_credit_notes.amount_applied` remains readable for history but is no
  longer the authority; `vendor_credit_movements` is.
- `src/test/architecture/compensation-writer-monopoly.test.ts` is the ratchet
  for both sides: a reintroduced legacy vendor writer, a direct
  `vendor_credit_notes` insert, or a client-side purchase-return journal builder
  fails CI.
