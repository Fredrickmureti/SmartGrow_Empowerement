# ADR 0001 — v1 Inventory Has No Per-Lot Quants

- **Status**: Superseded by [ADR 0025](./0025-lot-aware-quants-and-fefo.md) (2026-05-30)
- **Date**: 2026-04-23
- **Deciders**: Inventory architecture audit (Phases 1–3 implemented; Phase 4 documents deferrals)
- **Supersedes**: —
- **Superseded by**: ADR 0025 — Lot-aware quantities and FEFO picking

## Context

Odoo's inventory module models stock truth as `stock.quant`: a quadruplet of
`(product, location, lot/serial, package)` with a quantity. Every receipt,
delivery, and internal transfer mutates quants. Lots and serial numbers are
first-class citizens — the system enforces "you cannot deliver lot B if you
only received lot A" and computes FIFO/AVCO costs by quant age.

Our v1 stock model is intentionally simpler:

```
warehouse_stock(business_id, warehouse_id, product_id) UNIQUE
```

There is **no lot dimension** in `warehouse_stock`. The `goods_receipt_items`
table accepts `lot_number` and `serial_number` columns and the receiving UI
collects them, but those values are **advisory metadata only** — they are
written to the receipt line and never reconciled against stock.

## Decision

For v1 we keep `warehouse_stock` keyed at `(business_id, warehouse_id, product_id)` and treat every `lot_number`/`serial_number` captured during receipt as **searchable receipt metadata**, not as a stock dimension. The system will:

1. Continue to write lot/serial values to `goods_receipt_items` so audit and
   recall workflows can locate which receipts a lot came in on.
2. **Not** enforce that POS / Sales deliveries pick from a specific lot.
3. **Not** age-track lots for FIFO costing — costing remains per-product AVCO
   on receipt (see ADR 0002).
4. Surface a clear UI affordance ("Lot/serial — recorded for traceability,
   not enforced at sale") wherever the field is captured, so operators do not
   develop a false sense of compliance.

If a customer-recall or regulated-goods workflow becomes a hard requirement,
Phase 5 of the inventory audit (lot-aware quants + a unified
`stock_reservations` table) is the migration path.

## Consequences

### Accepted

- We can ship multi-branch stock truth without paying the schema-and-RPC cost
  of a full quant model.
- All existing flows (receipts, transfers, POS, sales, adjustments, physical
  count) operate on a single canonical row per `(business, warehouse, product)`,
  which keeps `update_product_stock` trigger logic simple and auditable.

### Sacrificed

- **No regulatory recall confidence.** If a lot is bad, we can identify
  *which receipts* contained it but cannot identify *which downstream sales*
  consumed it.
- **No expiry-based picking.** FEFO (first-expired-first-out) is impossible.
- **Lot UI is honest-but-narrow.** Front-end must label lot fields as
  metadata, not enforcement.

### Risks

- An operator may assume that capturing a lot at receipt restricts sale to
  that lot. The UI must explicitly state otherwise.
- Once Phase 5 is implemented, historical receipts predating the migration
  will have lot metadata but no quants — a backfill or "unknown lot" bucket
  is needed.

## Alternatives considered

1. **Build the full quant model now (Phase 5 today).** Rejected — the v1
   customer set does not have regulated/recall workflows; the engineering
   cost (rewrites to receive/transfer/POS/sales + reservation primitive +
   FIFO/AVCO recompute) is two to three weeks and would delay every other
   audit fix.
2. **Drop lot/serial columns from `goods_receipt_items` entirely.** Rejected
   — even advisory metadata has audit value, and the columns are already in
   the schema with referencing data.
