# ADR 0025 — Lot-aware quantities and FEFO picking

**Status:** Accepted (2026-05-30)
**Supersedes:** ADR 0001 (no-per-lot-quants-v1)
**Related:** ADR 0023 (UoM and packaging domain), ADR 0024 (cost scaling)

## Context

ADR 0001 deliberately deferred per-lot quantity tracking. The original
`stock_lots` table existed only as a master record of lot/serial identity;
on-hand quantities were aggregated to the warehouse level via
`warehouse_stock`. The audit performed before this ADR confirmed three
consequences:

1. Pharmacy, medical and FMCG customers could not answer the question "how
   many of lot ABC remain in this warehouse" without reconstructing it from
   the movement journal.
2. There was no first-expiring-first-out picking strategy; outbound
   consumption was strictly FIFO by receipt date.
3. Operators could not see, let alone override, the lot a sale would
   consume.

## Decision

Three coordinated changes establish lot-aware inventory:

### 1. Maintained per-lot balances

A new `AFTER INSERT` trigger `_maintain_warehouse_stock_lots` on
`stock_movements` upserts `warehouse_stock_lots.quantity` on every movement
that carries a `lot_number`. Lot master records are auto-created on first
receipt. Outbound movements for a missing lot raise.

### 2. Product-level switches

```
products.is_lot_tracked   boolean default false
products.is_expiry_tracked boolean default false
products.expiry_alert_days integer default 30
```

`is_lot_tracked = true` makes the trigger reject any outbound movement
without a `lot_number` for that product. `is_expiry_tracked = true`
additionally lights up FEFO consumption.

### 3. FEFO primitives

```
resolve_fefo_lots(business, warehouse, product, required_qty)
  → ordered allocation list (earliest expiry first; reservations honoured)
consume_lots_atomic(...allocations[])
  → writes N stock_movements rows in one transaction; trigger does the
    per-lot decrement
```

Operator overrides are first-class: `consume_lots_atomic` accepts a
caller-supplied allocation that may differ from the FEFO suggestion. Each
movement row stamps the override flag for audit. UI surface is
`LotPickerPopover`, which shows the suggestion as a chip and offers
alternatives in a popover.

## Adoption path

Existing atomic RPCs (POS, invoice confirmation, transfer, adjustment) keep
writing single-row outbound movements for non-lot-tracked products — zero
regression risk. Each RPC is migrated to call `consume_lots_atomic` for
lot-tracked products in its own focused migration so the change can be
verified against the live GL in isolation.

A one-click `rebuild_warehouse_stock_lots(business_id)` RPC reconstructs all
per-lot balances from movement history. The `lot_quant_drift_view` flags any
lot-tracked product whose per-lot balances no longer sum to the warehouse
total; a non-empty result is the trigger to rebuild.

## Consequences

- Pharmacies and medical suppliers can ship on Lovable Cloud without manual
  lot reconciliation.
- FEFO is opt-in at the product level. Non-pharmacy verticals are unaffected
  unless they tick the flag.
- The cost-layer trigger (`_maintain_cost_layers`) remains FIFO by receipt
  date. When a future iteration ties cost-layer consumption to the same lot
  the FEFO consumer empties, both ledgers stay aligned via `lot_number`.
