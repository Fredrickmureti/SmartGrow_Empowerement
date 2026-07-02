# ADR 0002 — Single Costing Method: AVCO on Receipt, Snapshot on Sale

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: Inventory architecture audit
- **Supersedes**: —
- **Superseded by**: —

## Context

Odoo supports three product costing methods, configurable per product:

| Method   | Cost on receipt              | Cost on sale                          |
| -------- | ---------------------------- | ------------------------------------- |
| Standard | Manual / fixed               | Standard cost (constant)              |
| AVCO     | Weighted average             | Current weighted average              |
| FIFO     | Layered                      | Oldest layer first                    |

Each method requires its own valuation engine. FIFO further requires per-quant
or per-layer age tracking — which we do not have (see ADR 0001).

Our codebase has a single helper, `update_weighted_avg_cost_on_receipt`, that
is called from `complete_goods_receipt_atomic` and updates `products.cost`
using a weighted-average formula across the prior on-hand and the receipt.
Sales (POS and delivery) record `cost_at_sale` as a snapshot of
`products.cost` at the moment of sale.

## Decision

Standardize on a **single costing method for all products**:

- **On receipt** — recompute `products.cost` using weighted average:
  `new_cost = ((qty_on_hand * old_cost) + (received_qty * receipt_unit_cost)) / (qty_on_hand + received_qty)`
- **On sale** — snapshot `products.cost` to `cost_at_sale` on the sale line
  and post COGS using that snapshot.
- **No per-product override.** Standard and FIFO are not exposed.

The `costing_method` column does not exist on `products` and will not be
added until Phase 5. Any RFP that asks for FIFO or Standard is a Phase 5
scope item.

## Consequences

### Accepted

- One valuation engine, one mental model. Auditors and accountants reading
  the COGS journal entries see a single deterministic rule.
- AVCO smooths price volatility — appropriate for the SMB segment that does
  not need to game tax timing via LIFO/FIFO.
- Snapshot-on-sale is the only correct behavior given that we have no
  retroactive cost rewrite path; if `products.cost` later changes, prior
  sales' COGS stays anchored to the cost at the time of sale.

### Sacrificed

- **No FIFO.** Customers in jurisdictions where FIFO is mandatory (some EU
  inventory standards, IFRS-leaning audits) cannot be served until Phase 5.
- **No standard cost variance accounting.** Manufacturing-style cost
  variance (purchase price variance, material usage variance) is not
  computed.
- **AVCO drift on negative stock.** If stock goes negative (only possible
  via an explicit `allow_negative` adjustment — see audit Phase 1), the AVCO
  formula's denominator becomes nonsensical. The receipt-cost helper guards
  this by clamping `qty_on_hand` to `MAX(0, qty_on_hand)` for the
  computation; the underlying stock balance still records as negative.

### Risks

- A customer importing legacy data with mixed costing assumptions will see
  costs converge to AVCO. Migration documentation must call this out.
- If Phase 5 introduces FIFO, every product's existing `products.cost` must
  be either (a) accepted as the opening AVCO and frozen, or (b) backfilled
  by walking the movement ledger. (b) is preferred but expensive.

## Alternatives considered

1. **Per-product `costing_method` column with three engines.** Rejected for
   v1 — three engines means three sets of edge cases (negative stock, partial
   returns, write-off, scrap) and three GL posting paths. Phase 5 work.
2. **Standard cost only.** Rejected — requires a full standard cost
   maintenance workflow (price list updates, variance posting) we have not
   built.
3. **FIFO only.** Rejected — requires per-layer storage, which is ADR 0001's
   deferred work.
