# ADR 0123 — Single Journal Posting Monopoly

Status: Accepted
Date: 2026-08-06

## Context

A settlement audit across AR, AP, POS, Payroll, Banking, Inventory and FX found
architectural drift: 18 database functions and 3 application/edge paths wrote
directly into `journal_entries` / `journal_entry_lines`, and several settlement
concerns were implemented twice (two `record_multi_invoice_payment` overloads,
a legacy `record_payment_atomic` with its own allocation logic, bank
reconciliation creating payments instead of matching them, an M-Pesa webhook
writing to a non-existent `invoice_payments` table, and a loan interest accrual
function inserting raw journal rows).

Every bypass path skipped the invariants the posting engine enforces: balanced
debits/credits, fiscal period locks, account posting-role validation,
organization/business coherence, idempotency by `(source_type, source_id)`, and
`accounting_events` emission.

## Decision

1. **One posting engine.** `public.post_journal_entry_atomic` is the only
   function permitted to insert journal rows, with `update_journal_entry_atomic`
   and `void_journal_entry_atomic` as its sibling mutators. Nothing else —
   no RPC, edge function, migration script or client — inserts into
   `journal_entries` or `journal_entry_lines`.
2. **One settlement engine per direction.** AR settles through
   `record_multi_invoice_payment`, AP through `record_multi_bill_payment`.
   Single-invoice and legacy entry points are thin shims over them, never
   parallel implementations. Unapplied customer receipts remain a distinct
   concern (`record_advance_payment`), because they allocate to nothing.
3. **Reconciliation validates, it never creates.** Bank reconciliation matches
   existing payments or delegates to the settlement engines. It may not mint
   payments as a side effect of matching.
4. **Document confirmation posts through the engine.** Bill, credit-note,
   goods-receipt, stock-adjustment, physical-count, payroll and FX revaluation
   posting all build their lines in memory and hand a single `jsonb` line array
   to the engine. Header-only concerns the engine does not model
   (`is_opening_entry`, `is_reversal`, `journal_book_id`, legacy
   `reference_type`) are stamped by an `UPDATE` after posting.

## Consequences

- Unbalanced entries now fail loudly instead of silently landing in the ledger.
- Locked-period writes are impossible from any path.
- Retry safety is uniform: the engine deduplicates by `source_type`/`source_id`.
- `src/test/architecture/journal-posting-monopoly.test.ts` is a ratchet: any new
  direct insert into journal or settlement tables from application code fails CI.
- Adding a new posting surface means writing a line builder, not a posting
  routine. Reviewers should reject any PR that reintroduces raw journal inserts.