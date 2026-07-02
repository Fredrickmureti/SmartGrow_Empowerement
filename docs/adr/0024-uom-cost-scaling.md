# ADR 0024 — Per-base-unit cost scaling on goods receipt

**Status:** Accepted (2026-05-30)
**Supersedes part of:** ADR 0002 (costing method)
**Related:** ADR 0023 (UoM and packaging domain)

## Context

Inventory items are purchased in pack units (Box of 10, Carton of 24, etc.)
but stocked, costed and sold against a base unit (tablet, can, kg). The GRN
completion path was originally written to take the purchase order's
`unit_price` directly as `stock_movements.unit_cost` against a
`quantity_received` value already normalised to base units.

When `unit_price = $50` for a Box of 10 tablets and a receipt of 1 Box
landed `quantity_received = 10 tablets`, the FIFO cost layer recorded
`$50/tablet` — a 10× overstatement of cost.

## Decision

`complete_goods_receipt_atomic` now scales the source price to a per-base-unit
cost before stamping `stock_movements.unit_cost`:

```
per_base_cost = po.unit_price * po.display_quantity / po.quantity
```

where `po.quantity` is the PO line's quantity in base units (already
normalised by `_uom_normalize_line`). When the two quantities match — the PO
was entered in base units — the cost passes through unchanged.

A new column `goods_receipt_items.unit_cost_basis ∈ {per_display_unit,
per_base_unit}` records the entered intent. `per_base_unit` bypasses scaling
for the rare case where a receiver enters cost already broken down.

## Backward compatibility

- Pre-fix journal entries are not retroactively corrected. The GL is
  immutable; correcting historical receipts would require reversing each
  related downstream cost-of-sale entry.
- A reconciliation view, `goods_receipt_lines_with_suspect_cost`, surfaces
  any completed receipt where the ledger line value diverges from
  `unit_price * display_quantity` by more than 1¢. Finance reviews each row
  on its own merits.

## Consequences

- Cost layers (`cost_layers.unit_cost`) and AVCO downstream calculations now
  reflect the true per-base-unit cost.
- COGS reports will diverge from pre-fix history at the cutover date; this
  is the expected and correct outcome.
- The scaling rule lives in one place (`complete_goods_receipt_atomic`).
  Sales/POS/transfer paths are unaffected: they multiply against the actual
  cost layer at consumption time, so the fix flows through automatically.
