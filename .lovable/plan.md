# Returns Domain — Convergence Plan & Status

Last updated: 2026-08-09
Active phase: **Phase 5 (closing)** — Phases 1-4 complete and verified.

## Verdict recap

The platform runs **two** return engines: the WMS RMA engine (`wms_return_orders`,
full inspection/disposition lifecycle) and the Sales finance engine
(`sales_returns` -> credit note / refund). They were not correctly seamed:
both restocked, numbering was broken, quantities were unbounded, and creation
was a multi-step client saga. The convergence keeps both engines but gives each
a single, non-overlapping responsibility:

- **WMS owns physical goods** (receipt, inspection, disposition, stock movement).
- **Sales owns the financial document** (credit note, refund, tax, AR effect).
- A WMS-sourced `sales_returns` row never moves stock; a sales-raised one does.

---

## Phase status

### Phase 1 — Kill double restocking (DONE, verified)
- `sales_returns.wms_return_order_id` added, backfilled, and auto-stamped by
  trigger when `wms_create_return_finance_doc` raises the finance document.
- `approve_sales_return_atomic` rewritten: skips all inventory movement when the
  return is WMS-sourced (warehouse dispositions already moved the goods).
- Damaged/defective lines on sales-raised returns route to a `quarantine`
  stock location instead of sellable stock.
- Approval is blocked when the target accounting period is closed (previously
  COGS was silently skipped).

### Phase 2 — Returnable quantity ledger (DONE, verified)
- `v_sales_returnable_qty` derives delivered/invoiced qty minus already-returned
  qty per invoice line.
- `trg_enforce_sales_return_qty_ledger` rejects over-returns at write time.
- Final re-validation happens under `FOR UPDATE` inside
  `approve_sales_return_atomic`, closing the check-then-act race.

### Phase 3 — Server-owned creation, numbering, idempotency (DONE, verified)
- `get_next_sales_return_number` rewritten: per-business advisory lock,
  trailing-digit suffix only (the old version folded the year into the counter
  and produced `SR-2026-20260002`), configurable prefix via the new
  `businesses.sales_return_prefix`.
- `assign_sales_return_number` BEFORE INSERT trigger is the single allocation
  point, so WMS-raised returns join the same series.
- `uq_sales_returns_org_number` makes duplicate numbers impossible.
- `create_sales_return_atomic(_payload jsonb)`: header + lines + server-derived
  totals in one transaction; `client_request_id` (unique partial index) makes a
  retry return the existing document instead of a duplicate.
- `src/hooks/useSalesReturns.ts` no longer inserts headers or lines directly.

### Phase 4 — Lifecycle enforcement (DONE, verified)
- `transition_sales_return(_return_id, _to_status, _reason)` enforces
  `pending -> rejected`, `approved -> received`, `received -> refunded`; it
  refuses `approved`, which belongs solely to `approve_sales_return_atomic`.
- Same-status calls are idempotent no-ops.
- The hook's `updateSalesReturn` and `rejectReturn` route status changes through
  the RPC; free-form client status writes are gone.

### Phase 5 — Access parity and reporting provenance (IN PROGRESS)
Done:
- `sales_return_items` permissive `ALL` policy replaced with four
  credit-note-parity policies (business + branch + `sales` module permission per
  operation), plus explicit grants.
- Sales Return record page shows **Origin** (`Warehouse RMA <no>` vs
  `Direct (sales-raised)`) and an activity entry stating that stock movements
  are owned by the warehouse for WMS-sourced returns.

Pending:
1. **Returns list + peek provenance** — `src/pages/SalesReturns.tsx` and
   `SalesReturnPeekSheet.tsx` still show no origin column/badge.
2. **Reporting parity** — returns-related reports and the sales dashboard should
   attribute a return once (finance) and never double-count the WMS RMA.
3. **Architecture ratchets** — extend
   `src/test/architecture/journal-posting-monopoly.test.ts` (or a sibling
   returns ratchet) to ban: client inserts into `sales_returns` /
   `sales_return_items`, and client writes to `sales_returns.status`.
4. **pgTAP coverage** — `supabase/tests/` has no returns suite. Add: numbering
   uniqueness under concurrency, idempotent create replay, over-return
   rejection, WMS-sourced approval issuing zero stock movements, and each
   forbidden lifecycle edge raising.

---

## Next agent — start here

**Step 1: verify before building.** Do not assume the above is correct.
- Confirm the four RPCs exist and behave as documented:
  `create_sales_return_atomic`, `transition_sales_return`,
  `get_next_sales_return_number`, `approve_sales_return_atomic`.
- Confirm `trg_assign_sales_return_number`, `uq_sales_returns_org_number`,
  `uq_sales_returns_client_request` and the four `sales_return_items_*_v2`
  policies are present.
- Spot-check real data: any `sales_returns.return_number` that still matches the
  malformed `SR-YYYY-YYYYNNNN` shape, or any WMS-sourced return that also has
  `stock_movements` attributed to it, is leftover damage from before the fix and
  needs a data-repair migration, not a code change.

**Step 2: resume at Phase 5 pending item 1**, then 2, 3, 4 in that order. Finish
Phase 5 completely before opening any new area.

**Step 3 (only after Phase 5 closes): Phase 6 — cost basis fidelity.** Returned
goods are currently restocked at a recomputed cost rather than the original
outbound cost layer. Consuming the original `cost_layer_consumptions` rows for
the invoice line is the correct enterprise behaviour and is the next milestone
after Phase 5.

**Rules for this domain.** Never reintroduce client-side inserts into
`sales_returns`/`sales_return_items`, client status writes, or a second restock
path. All journal effects go through `post_journal_entry_atomic` (ADR 0123).