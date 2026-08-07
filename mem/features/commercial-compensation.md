---
name: Commercial compensation architecture
description: Credit notes, customer credit ledger, single refund engine, business-scoped numbering (ADR 0131)
type: feature
---

ADR 0131 governs credit notes, customer credit and refunds.

- Credit note = commercial document. Issuing reverses revenue + tax; the
  counter-leg is decided server-side: reduce AR only up to the linked invoice's
  open balance, remainder becomes customer credit. The browser never decides
  this and never builds journal lines.
- Customer credit is a real liability: `customer_credit_balances` projected from
  append-only `customer_credit_movements` (issue/apply/refund/expire). Never
  derive availability from `credit_notes.total - amount_applied`.
- Canonical writers: `create_credit_note_atomic`, `issue_credit_note_atomic`,
  `apply_credit_to_invoice_atomic`, `refund_customer_atomic` (one refund engine
  for both payments and credit notes; `process_refund_atomic` is retired).
  Posting still only via `post_journal_entry_atomic` (ADR 0123).
- Inventory moves only through a `sales_returns` document linked by
  `credit_notes.source_return_id`; a credit note alone moves no stock.
- Credit-note numbering is business-scoped and advisory-locked; prefixes live on
  `businesses` (`credit_note_prefix`), NOT on `organizations`. No client-side
  fallback numbers ("VCN-001", `DN-${Date.now()}`) — they collide.
- Ratchet: `src/test/architecture/compensation-writer-monopoly.test.ts`.