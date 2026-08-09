# Returns Domain — Convergence: CLOSED

All phases (1-9) are complete and verified against the live database.
Nothing in this plan is open. Future returns work starts from the standing
rules at the bottom of this file.

## Final phase — 9.3 data repair (closed)

A live census of the database was run before writing any repair:

| Check | Rows found |
| --- | --- |
| malformed `SR-YYYY-NNNN` numbers | 0 |
| duplicate numbers per business | 0 |
| WMS returns carrying their own `stock_movements` | 0 |
| `refunded` returns short in `v_sales_return_settlement` | 0 |
| lines missing cost basis or tax basis | 0 |

There was no pre-fix damage to repair, so a one-off data migration would have
been a no-op. The durable equivalents were shipped instead:

- **`v_sales_returns_integrity`** — a permanent, security-invoker census view.
  One row per defective return, with `bad_number_format`, `duplicate_number`,
  `double_restock`, `refunded_unsettled`, `settlement_shortfall`,
  `lines_without_cost_basis`, `lines_without_tax_basis`. Currently returns 0
  rows; any future drift surfaces here instead of hiding.
- **`repair_sales_return_numbers(_org_id)`** — idempotent renumbering of
  malformed numbers through the canonical generator, `service_role` only,
  returns the old/new pairs it changed.
- **Legacy numbering path removed** — the single-argument
  `get_next_sales_return_number(uuid)` overload (the producer of the old
  `SR-YYYY-NNNN` format) was dropped. Exactly one numbering entry point remains:
  `get_next_sales_return_number(org, business, branch)`, reached only through the
  `BEFORE INSERT` trigger.

## What the domain now looks like

- WMS owns the physical goods; Sales owns the financial documents. One restock
  path, one numbering path, one fiscal exit.
- Creation, transition, approval and refund are server-atomic
  (`create_sales_return_atomic`, `transition_sales_return`,
  `approve_sales_return_atomic`, `refund_customer_atomic`). The client never
  inserts, never numbers, never sets status.
- Cost basis: `resolve_sales_return_line_cost` + `sales_return_cost_basis`.
- Tax basis: snapshotted from the invoice line
  (`resolve_sales_return_line_tax`), rounded once per document, carried into the
  credit note with its eTIMS codes.
- Fiscal: the credit note is the only transmitted artefact and back-references
  the reversed invoice's transmission.
- Settlement truth: `v_sales_return_settlement`.

## Guards (all green)

- `src/test/architecture/sales-returns-single-writer.test.ts` — 5 ratchets, passing.
- `supabase/tests/sales_returns_convergence_test.sql` — 40 assertions, now also
  covering the census view, the repair function and the single numbering entry point.

## Standing rules for this domain

Never reintroduce client-side inserts into `sales_returns`/`sales_return_items`,
client status writes, client numbering, a second restock path, or a second
numbering overload. Cost basis comes from `resolve_sales_return_line_cost`; tax
truth from the invoice-line snapshot; settlement truth from
`v_sales_return_settlement`. All journal effects go through
`post_journal_entry_atomic` (ADR 0123).
