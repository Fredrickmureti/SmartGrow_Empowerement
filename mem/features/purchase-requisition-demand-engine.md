---
name: Purchase requisition demand engine
description: PR lifecycle is DB-owned — quantity rollups via _pr_recalc, short-close RPCs, governance registration, bucketed workbench
type: feature
---

# Purchase requisitions = demand-origin domain

Not a form. The requisition is the origin of procurement demand and the
database owns every quantity and state transition.

## Server-owned state

- `_pr_recalc` is the single rollup engine. Line status is **quantity-driven**:
  `open → partially_ordered → ordered → partially_received → received`, using
  `quantity`, `quantity_ordered`, `quantity_received`, `quantity_cancelled`.
  **Cancelled purchase orders are excluded from the rollup.**
- Header status is folded from the line states
  (`approved / sourcing / partially_procured / procured / ordered /
  partially_fulfilled / fulfilled / closed`).
- Outstanding demand on a line = `quantity − quantity_ordered −
  quantity_cancelled`, floored at 0. The UI mirrors this formula but never
  invents state.

## Short-close

- `requisition_close_line(_item_id, _reason)` cancels the un-ordered balance
  on one line.
- `requisition_close(_requisition_id, _reason)` short-closes every line with
  outstanding demand; the header lands on `closed`.
- Quantities already on a PO are untouched — the PO keeps its own lifecycle.

## Client rules

- The browser NEVER writes `purchase_requisitions` / `purchase_requisition_items`
  lifecycle columns. All transitions go through
  `src/features/purchases/requisitions/requisitionRpcs.ts` — the single wrapper
  module (guarded by `src/test/architecture/requisitions.test.ts`).
- Progress is read from the line rollup columns only; never re-summed from
  `purchase_order_items` or goods receipts.
- The workbench list is bucketed as a work queue (Needs action, Drafts,
  Awaiting approval, In sourcing, On order, Overdue, Settled, All), not a
  status dropdown.

## Governance

`requisition.submit` and `requisition.approve` are registered in
`governance_action_registry` (`severity_default` must be one of
`low | standard | high | critical`). Approval routes through
`approval_route('requisition.approve', ...)`. The ungated fallback delegates
self-action decisions to `governance_assert_not_self`; solo/standard/strict,
per-action policies, and one-time overrides are never reimplemented locally.

SQL invariants: `supabase/tests/purchase_requisitions_demand_engine_test.sql`.
