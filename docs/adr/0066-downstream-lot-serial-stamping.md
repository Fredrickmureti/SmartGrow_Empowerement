# ADR 0066 — Downstream lot/serial stamping contract

**Status:** Accepted (2026-07-16)
**Related:** ADR 0025 (lot-aware quants and FEFO), ADR 0064 (stock locations and quants)

## Context

The `.lovable/plan.md` audit found that two-way recall — "which customer
bought Batch A?" — was only reliably answerable for POS sales and delivery
notes. `pos_transaction_items` and `delivery_note_items` already carry
`lot_number` and `serial_number`. The other outbound sales-side line tables
(`invoice_items`, `sales_order_items`, `sales_return_items`,
`credit_note_items`) did not, so a lot-tracked product sold on a
non-POS invoice was invisible to recall.

For an enterprise ERP where inventory is the single source of truth,
downstream traceability must be uniform across every outbound path, not
just the POS-first paths.

## Decision

All outbound sales-side line tables must record the lot and/or serial
that was consumed against each line, at the same column names
(`lot_number text`, `serial_number text`). A single canonical view,
`v_lot_downstream_consumption`, unifies every downstream consumption
event so recall queries have one contract:

```sql
SELECT * FROM public.v_lot_downstream_consumption
 WHERE lot_number = :lot;
```

returns POS, delivery-note, invoice, sales-return and credit-note
consumption rows with `document_type`, `document_number`, `contact_id`,
`occurred_at`, and `quantity`.

## Phased rollout

### Phase A.1 — Schema + recall view (this ADR, delivered)

- Add `lot_number`, `serial_number` to the four missing tables.
- Publish `v_lot_downstream_consumption`.
- Purely additive; no writer changes; safe to deploy at any time.

### Phase A.2 — Enforcement + RPC wiring (next migration)

- Extend the four outbound RPCs (`confirm_invoice_atomic`,
  `confirm_credit_note_atomic`, `approve_sales_return_atomic`,
  `confirm_sales_order_atomic`) to thread each line's `lot_number` /
  `serial_number` through to the emitted `stock_movements` — reuse
  `consume_lots_atomic` for FEFO-picked lots.
- Add a `CONSTRAINT TRIGGER ... INITIALLY DEFERRED` on each of the four
  tables: for a line whose product is `is_lot_tracked` or
  `is_serial_tracked`, the corresponding column must be non-null when
  the parent document is in a posted status. Draft / cancelled statuses
  are exempt so drafts still work.
- Architecture test (`outbound-lot-stamping.test.ts`) asserts every
  outbound RPC forwards the lot/serial to the ledger.

### Phase A.3 — Backfill (only if legacy data exists)

Because the platform has no production users, no backfill is planned.
If historical rows arrive from tenant migration, the operator-tools
backfill script stamps lot/serial from the linked `stock_movements` row
by `(reference_type, reference_id, product_id)`; ambiguous matches are
flagged as "legacy — unknown lot" rather than silently nulled.

## Consequences

- Recall queries return uniform results across every sales channel.
- Sales-side RPCs gain a small but strict contract: for lot/serial
  products, the caller must pick a lot or use FEFO resolution — there
  is no "quiet skip" path.
- POS and delivery-note lines already conform; the enforcement trigger
  will hard-catch any future regression on those paths as a side benefit.
- Report writers must migrate off "join to `stock_movements` to find the
  lot" and onto `v_lot_downstream_consumption`. The old join keeps
  working; the view is the recommended surface.

## Non-goals

- Batch-level accounting cost. FIFO cost layers already track lot-agnostic
  layers by receipt date (ADR 0025); this ADR does not tie cost to lot.
- Serial-tracked products in the ledger. That is Phase B (ADR 0067) —
  this ADR only reserves the `serial_number` column shape so Phase B
  does not require a schema change.