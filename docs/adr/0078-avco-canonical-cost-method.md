# ADR 0078 — AVCO is the Canonical Cost Method

**Status:** Accepted (2026-07-17) · **Amends:** 0002 · **Related:** 0025 (batch/lot), 0067 (serial)

## Context

Audit §9 identified an ambiguity: ADR 0002 declares "AVCO on receipt, snapshot on sale" as the single cost method, yet the schema also contains `cost_layers` and `cost_layer_consumptions` tables with a maintenance trigger (`trg_maintain_cost_layers`). Two cost methods coexisting is a finance-critical defect.

A codebase sweep found **no client (TypeScript) reader of `cost_layers` or `cost_layer_consumptions`**. The tables are populated by DB triggers but never consulted for valuation reporting.

## Decision

1. **AVCO is canonical.** Product weighted-average cost (`products.cost_price`, updated by `trg_update_wac_on_receipt`) is the single source of truth for inventory valuation and COGS.

2. `cost_layers` / `cost_layer_consumptions` are **downgraded to lot-cost detail only**. They exist to record the acquisition cost of each lot for lot-tracked products (needed for FEFO lot valuation and traceability reports), but they are **not** consulted for AVCO or COGS.

3. Any future reader that queries `cost_layers` for a valuation number MUST route through a wrapper that reconciles with `products.cost_price` — a divergence is a bug in the layer maintenance, not a choice of cost method.

4. `reverse_stock_movement` RPC contract is committed as a follow-up so every reference type has a canonical reversal path.

## Enforcement

A future architecture test will grep for direct SELECTs on `cost_layers.*_cost` fields outside the maintenance trigger and lot-valuation reports.

## Consequences

- Finance reporting is unambiguous: valuation = `SUM(stock_quants.quantity * products.cost_price)`.
- Lot-tracked products retain per-lot cost detail via `cost_layers`, which is required for FEFO consumption and recall costing.
- ADR 0002 remains authoritative; this ADR removes the ambiguity that made 0002 defensible-but-fragile.