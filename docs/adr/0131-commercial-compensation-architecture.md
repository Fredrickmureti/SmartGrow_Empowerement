# ADR 0131 — Commercial Compensation Architecture (credit notes, customer credit, refunds)

Status: Accepted
Date: 2026-08-07

## Context

Voiding a settled invoice is correctly blocked (ADR 0127–0130) and the operator is
told to issue a credit note, refund the customer, or reverse the payment. The
documents behind those recommendations had drifted:

- `get_next_credit_note_number(_org_id)` read `organizations.credit_note_prefix`, a
  column that does not exist, so every credit note creation failed with HTTP 400.
  It was also the only document sequence that was org-scoped and unlocked, while
  every other sequence is business-scoped and advisory-locked.
- Journal lines for issuing and refunding a credit note were built **in the
  browser** (`buildCreditNoteJELines`, `buildRefundJELines`) and the GL accounts
  were resolved client-side, from a client-side "is the invoice fully paid?" probe.
- Two refund engines existed: `process_refund_atomic` (browser-built JE, updated
  `credit_notes.refund_amount`, wrote no refund record) and
  `refund_customer_atomic` (server-built JE, wrote `customer_refunds`).
- Customer credit was not modelled. It was derived as
  `credit_notes.total - amount_applied`, and depending on that browser probe the
  same economic balance landed in Accounts Receivable **or** in Customer Deposits —
  which the GL-anchored AR/AP open-items engine (ADR 0033) cannot reconcile.

## Decision

1. **A credit note is a commercial document, not a settlement.** Issuing it
   reverses revenue and tax. Its counter-leg is decided by the server, never the
   client: it reduces the receivable only up to the linked invoice's still-open
   balance; any remainder (settled invoice, or no invoice) becomes **customer
   credit**.
2. **Customer credit is a liability with its own ledger.**
   `customer_credit_balances` is a projection of append-only
   `customer_credit_movements` (`issue`, `apply`, `refund`, `expire`). It always
   posts to the customer-credit liability account, never to AR. Availability for
   application or refund is read from the balance, never derived from a document
   column. Balances may not go negative.
3. **One writer per compensation act.** `create_credit_note_atomic` (header,
   lines, number in one transaction), `issue_credit_note_atomic` (GL lines built
   in the database from `default_account_settings`),
   `apply_credit_to_invoice_atomic`, `refund_customer_atomic`. Posting still goes
   only through `post_journal_entry_atomic` (ADR 0123).
   `confirm_credit_note_atomic` survives as a thin shim over
   `issue_credit_note_atomic` and ignores any client-supplied lines.
4. **One refund engine.** `refund_customer_atomic` serves both sources (payment
   and credit note), always writes a `customer_refunds` row plus a credit
   movement, and is idempotent by `client_request_id`.
   `process_refund_atomic` is dropped — no fallback path.
5. **Inventory participates only via a return document.** Stock and COGS effects
   come from `sales_returns` linked through `credit_notes.source_return_id`; a
   credit note with no return moves no stock. Tax follows the credit note's own
   document date through the existing fiscal/eTIMS enqueue path, not the refund.
6. **Numbering follows the canonical rule.** `get_next_credit_note_number(_org,
   _business, _branch)` and `get_next_vendor_credit_note_number(_org, _business)`
   are business-scoped, advisory-locked, and read the prefix from `businesses`.
   No client-side fallback numbers.

## Consequences

- Aging, customer statements, partner ledger and trial balance now agree on where
  a customer credit lives, because only one account is ever used.
- A refund can never exceed available credit, and every refund is traceable
  invoice → credit note → movement → refund → journal entry → bank.
- `credit_notes.amount_applied` / `refund_amount` remain readable for history but
  are no longer the authority; `customer_credit_movements` is.
- `src/test/architecture/compensation-writer-monopoly.test.ts` is the ratchet: any
  reintroduced client-side compensation JE builder, second refund writer, or
  org-only credit-note numbering call fails CI.