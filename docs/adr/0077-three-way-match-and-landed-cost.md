# ADR 0077 — Three-Way Match & Landed Cost

**Status:** Accepted (2026-07-17) · **Related:** 0002 (AVCO cost), 0064 (quants), 0069 (ASN)

## Context

Audit §6 flagged two blocking gaps in the Goods Receipt pillar:

1. **2-way match only** — Bill ↔ PO existed, but there was no line-level Bill ↔ GRN linkage, so quantity/price variance could not be detected per receipt line.
2. **No landed cost mechanism** — Freight, duty, insurance sat on the bill as separate lines and never entered inventory cost. Cost-of-goods was systematically understated.

## Decision

Introduce three tables and one column:

### `bills.goods_receipt_id` (nullable)
Direct header-level link for the common single-GRN-per-bill case.

### `bill_grn_matches`
Line-level junction: `(bill_item_id, goods_receipt_item_id, matched_quantity, unit_cost_variance)`. UNIQUE on `(bill_item_id, goods_receipt_item_id)`. Enables true 3-way match: PO qty ↔ GRN qty ↔ Bill qty.

### `landed_cost_bills`
Header for freight, duty, insurance, handling, brokerage bills that must be distributed into inventory cost. Fields: `cost_type`, `total_amount`, `allocation_basis` (quantity | value | weight | manual), `status` (draft → allocated → posted → reversed).

### `landed_cost_allocations`
Per-GRN-line allocation: `(landed_cost_bill_id, goods_receipt_item_id, basis_value, allocation_ratio, allocated_amount, posted_movement_id)`. UNIQUE on `(landed_cost_bill_id, goods_receipt_item_id)`.

When status transitions to `posted`, a downstream RPC (next session) will:
1. Insert an adjustment `stock_movement` per allocation row carrying `unit_cost = allocated_amount / matched_quantity`.
2. Stamp `posted_movement_id`.
3. Feed AVCO via the existing `trg_update_wac_on_receipt` trigger.

## RLS

All three tables scope to `user_business_access.business_id`. Write allowed for `owner | admin | accountant | staff`. Members can read.

## Consequences

- 3-way variance is now first-class data (not derived from joins across bills and GRNs).
- Retail/pharmacy verticals can price imported goods correctly on day one.
- Requires a follow-up: (a) UI for the landed-cost bill wizard, (b) posting RPC that emits the adjustment movements, (c) reversal RPC.

## Non-goals

- EDI ingest (audit noted CSV + ASN cover 90 % of retail SMB — deferred).
- Multi-currency landed cost (currency column exists; FX conversion follows the same rules as bills).