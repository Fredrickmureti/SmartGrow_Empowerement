# ADR 0128 — POS Accounting Boundary: Statement-Centric Posting and a Single Credit-Sale Writer

Status: Accepted
Date: 2026-08-06

## Context

POS is the highest-volume money surface in the platform. Two questions had never
been fixed in writing, and both were drifting:

1. **Where does POS become accounting?** Historically a per-sale poster
   (`post_pos_sale_gl`) wrote GL for every transaction. That couples the
   cashier's commit latency to a finance write, multiplies journal volume by
   receipt count, and makes a register's cash position derivable from two
   different places.
2. **Who creates the receivable for an on-account sale?**
   `usePOSCreditSale` reserved an invoice number, inserted `invoices`, inserted
   `invoice_items`, then updated `pos_transactions.invoice_id` — four
   round-trips with no transaction. Any failure mid-sequence left a completed
   sale with a missing or partial receivable, and a retry could mint a
   duplicate invoice.

## Decision

1. **The register period statement is the POS accounting document.**
   Per-sale posting is demoted to shadow only: `post_pos_sale_gl` records into
   `pos_gl_shadow_postings` and writes no ledger rows, ever. Authoritative GL
   arrives on statement close.
2. **Statement close is asynchronous, event-carried and idempotent.**
   `_pos_stmt_enqueue_gl_post` writes an `accounting_events` row keyed
   `pos:pos_statement:<statement_id>:v1` and enqueues
   `pos.statement.posting.requested` on the business event outbox. The
   `outbox-dispatcher` handler resolves the accounting event and calls
   `post_pos_statement_gl`, which composes its lines and hands them to
   `post_journal_entry_atomic` (ADR 0123). A retried statement collapses to one
   journal entry.
3. **A closed register may not carry unposted cash indefinitely.**
   Statements stuck in `posting_status = 'pending'` after close are a finance
   exception, surfaced by the drift view — not a silent state.
4. **POS on-account sales have one document writer.**
   `create_pos_credit_sale_invoice_atomic(_pos_transaction_id, _due_days, _user_id)`
   creates the invoice header, copies the committed POS lines, and links
   `pos_transactions.invoice_id` in a single transaction. It is idempotent by
   POS transaction id (an already-linked invoice short-circuits), derives the
   credit amount from recorded `pos_transaction_payments` tenders rather than
   client input, and refuses a sale with no customer or no branch context.
   Confirmation and GL continue through the canonical invoice pipeline
   (`confirmInvoiceAndPostGL` → `post_journal_entry_atomic`), so a POS credit
   sale is accounted exactly like any other sales invoice.

## Consequences

- Cashier commit never blocks on a finance write, and never mints a journal.
- POS GL volume is per register period, not per receipt, and reconciles against
  a single statement document.
- A retried credit sale returns the existing invoice instead of duplicating AR.
- `src/test/architecture/pos-statement-gl-cutover.test.ts` and
  `pos-credit-sale-single-writer.test.ts` are ratchets: re-introducing per-sale
  journal writes, a second POS→GL path, or client-side invoice creation from POS
  code fails CI.
