# Returns Domain — Convergence Status

Phases 1-7: complete and independently re-verified against the live database.
Phase 8 (tax fidelity & fiscal transmission): **complete**.
Phase 9 items 1 and 2: **complete**. Item 3 (data repair) is the only open work.

## Phase 8 — shipped

**Tax basis is the invoice line, not the product.**
- `resolve_sales_return_line_tax(invoice_item_id, qty)` returns the net-of-discount
  unit price, the pro-rated tax (from the invoice line's *stored* tax_amount, so
  historic rounding is honoured), the rate, the discount and the eTIMS codes.
- `create_sales_return_atomic` calls it for every line carrying an
  `invoice_item_id` and ignores client-supplied price and tax for those lines.
  Manual lines keep the supplied rate and are stamped `tax_basis_source = 'manual'`.
- New columns on `sales_return_items`: `source_tax_rate`, `source_tax_amount`,
  `source_discount_percent`, `etims_tax_code`, `etims_classification_code`,
  `tax_basis_source`. Existing rows were backfilled from their invoice line.
- Rounding is settled once per document: lines hold 6 dp, the header rounds to
  2 dp, and the delta lands on the largest tax line so output tax cannot drift.

**The basis reaches the credit note.**
- `credit_note_items` gained `etims_tax_code` / `etims_classification_code`;
  `approve_sales_return_atomic` and `create_credit_note_atomic` propagate them.

**One fiscal document per reversal.**
- `trg_sales_return_fiscal_enqueue` dropped — the return is internal, the credit
  note is the fiscal artefact.
- `fiscal_transmissions` gained `original_transmission_id` /
  `original_fiscal_number`; a BEFORE INSERT trigger resolves the reversed
  invoice's latest successful transmission and mirrors it into the payload.

**Client (presentation only).**
- `SalesReturnCreatePage` seeds invoice lines at the discounted net price, previews
  tax by pro-rating the invoice line's own tax, no longer lets the current product
  price or rate overwrite an invoice-sourced line, and states that the server
  confirms tax on save.

## Phase 9 — items 1 and 2 shipped

1. Invoice-sourced lines now take their price from the invoice line (net of the
   original discount); the browser's price is used only for manual lines.
2. The credit note is dated `COALESCE(return_date, CURRENT_DATE)`, so a reversal
   cannot drift into a different period from the return it settles.

## Guards

- `src/test/architecture/sales-returns-single-writer.test.ts` — 5 ratchets: no
  direct inserts, no client status writes, no client numbering, no product-rate
  tax derivation on returns pages, no product price overwrite of an
  invoice-sourced line.
- `supabase/tests/sales_returns_convergence_test.sql` — 34 assertions (was 22),
  covering the new columns, the resolver, the credit-note date, the absent
  fiscal trigger and the transmission back-reference.

## Open — Phase 9 item 3 (data repair, not a code change)

A repair migration is still needed for pre-fix damage:
- malformed `SR-YYYY-YYYYNNNN` numbers,
- WMS-sourced returns that also carry `stock_movements` (double restock era),
- `refunded` returns whose settlement is short in `v_sales_return_settlement`.

This should be scoped from a live census of the affected rows before it is written.

## Rules for this domain

Never reintroduce client-side inserts into `sales_returns`/`sales_return_items`,
client status writes, or a second restock path. Cost basis comes from
`resolve_sales_return_line_cost`; settlement truth from
`v_sales_return_settlement`; tax truth from the invoice-line snapshot. All
journal effects go through `post_journal_entry_atomic` (ADR 0123).
