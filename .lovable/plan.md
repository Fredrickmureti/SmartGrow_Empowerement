# Returns Domain — Convergence Plan & Status

Last updated: 2026-08-09
Active phase: **Phase 8 (not started)** — Phases 1-7 complete and verified.

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

### Phase 5 — Access parity, provenance and guardrails (DONE, verified)
- `sales_return_items` permissive `ALL` policy replaced with four
  credit-note-parity policies (business + branch + `sales` module permission per
  operation), plus explicit grants.
- **Provenance is visible on every returns surface.** Record page and peek sheet
  show `Origin` (`Warehouse RMA <code>` vs `Direct (sales-raised)`) plus an
  activity entry stating stock movements are owned by the warehouse; the list
  carries a `Warehouse` badge next to the return number. All three read
  `wms_return_orders(id, code, state)`.
- **Reporting parity — verified, no change required.** No report or dashboard
  reads `sales_returns` or `wms_return_orders` directly; return value reaches
  reporting only through the issued credit note, so a return is attributed
  exactly once and the WMS RMA cannot double-count it.
- **Architecture ratchet**: `src/test/architecture/sales-returns-single-writer.test.ts`
  (3 tests, passing) bans client inserts into `sales_returns` /
  `sales_return_items`, client writes to `sales_returns.status`, and any
  client-side number allocation.
- **pgTAP suite**: `supabase/tests/sales_returns_convergence_test.sql` (9 tests)
  asserts both RPCs exist with the right signature, both unique indexes and the
  numbering trigger are installed, the generated number carries no embedded
  year, numbering refuses to run without a business, both write RPCs refuse an
  unauthenticated caller, and `transition_sales_return` never approves.

---

### Phase 6 — Cost basis fidelity (DONE, verified)
- `sales_return_cost_basis` (one row per restored return line: unit cost, total
  value restored, method, fallback qty, fallback reason) and
  `sales_return_cost_allocations` (which original outbound
  `cost_layer_consumptions` portions the line was matched against) added, with
  grants and business-scoped read-only RLS. Only SECURITY DEFINER code writes them.
- `resolve_sales_return_line_cost(business, invoice, product, qty)` walks the
  consumptions produced by the delivery(ies) that shipped the invoice, oldest
  first, **net of what earlier returns already restored** (allocations prevent
  the same outbound cost being reused twice), and falls back to
  `delivery_note_items.cost_at_shipment`, then `products.cost_price`.
- `approve_sales_return_atomic` now values the `return_in` movement at that
  resolved original cost instead of the recomputed current cost, and writes the
  basis + allocation rows per line. Quantity accounting is unchanged (one new
  layer per receipt) so no double counting is introduced; only the *value* is
  now faithful to the outbound layer.
- Fallbacks are explainable: `method` (`cost_layer` / `mixed` / `delivery_note`
  / `product_cost` / `none`), `fallback_qty` and `fallback_reason` are stored and
  surfaced. The record page shows a per-line `Cost basis` column and an activity
  entry per line, toned `warning` when any quantity fell back.
- pgTAP suite extended to 16 tests: both tables exist, one basis row per line is
  enforced, the resolver exists with the right signature, and a line with no
  outbound history is fully flagged as fallback with a reason.
- Architecture ratchet still green (3 tests).

### Phase 7 — Settlement & refund completeness (DONE, verified)
- `v_sales_return_settlement` (security_invoker view, granted to `authenticated`)
  is the single settlement position per return: `credited`, `applied`,
  `refunded`, `open_credit` and `is_settled`. Each amount is counted once, so a
  return credited partly to AR and partly to customer credit reports one
  non-double-counted position.
- `transition_sales_return` now refuses `received -> refunded` unless the credit
  note exists, is `issued`/`applied`/`refunded`, and
  `amount_applied + refund_amount >= total` (0.01 tolerance). The status can no
  longer run ahead of the money; the error names the shortfall and hints at the
  fix.
- Refund idempotency end to end: `useCreditNotes.processRefund` accepts a
  caller-owned `clientRequestId` (the `Date.now()` suffix that defeated
  `refund_customer_atomic`'s dedupe is gone), and
  `ProcessRefundWizardPage` mints one UUID per submission attempt in a ref —
  retries of a failed submit dedupe, a genuinely new refund gets a new key.
- The record page shows the settlement line (`Settled/Outstanding — applied X,
  refunded Y, open credit Z`).
- pgTAP suite extended to 22 tests: the view and its `is_settled` / `open_credit`
  columns exist, no return is settled beyond what it was credited, every
  `refunded` return carries a credit note, and the transition refuses to settle
  a return with no settled credit note.
- Architecture ratchet still green (3 tests); typecheck clean.

---

## Next agent — start here

**Step 1: verify before building.** Do not assume the above is correct.
- Re-run `npx vitest run src/test/architecture/sales-returns-single-writer.test.ts`
  and exercise `supabase/tests/sales_returns_convergence_test.sql` against the DB.
- Confirm Phase 1-5 objects: `create_sales_return_atomic`,
  `transition_sales_return`, `get_next_sales_return_number`,
  `approve_sales_return_atomic`, `trg_assign_sales_return_number`,
  `uq_sales_returns_org_number`, `uq_sales_returns_client_request`, the four
  `sales_return_items_*_v2` policies.
- Confirm Phase 6: `sales_return_cost_basis`, `sales_return_cost_allocations`,
  `resolve_sales_return_line_cost`; approving a sales-raised return must write
  exactly one basis row per product line.
- Confirm Phase 7: `v_sales_return_settlement` returns one row per return, and
  `transition_sales_return(..., 'refunded')` fails on an unsettled return.
- Spot-check data: malformed `SR-YYYY-YYYYNNNN` numbers, WMS-sourced returns
  that also carry `stock_movements`, or `refunded` returns whose settlement is
  short, are pre-fix damage and need a data-repair migration, not a code change.

**Step 2: resume at Phase 8 — tax fidelity on returns.** Next milestone, do not
open unrelated areas.

### Phase 8 — Tax fidelity & fiscal transmission (NEXT, not started)
1. A return must reverse the tax the *original invoice line* charged (rate,
   category, exemption), not the product's current tax setting — snapshot the
   invoice line's tax basis onto the return line at creation time.
2. Partial returns must reverse tax proportionally, with rounding handled once at
   document level so line rounding never drifts the output-tax control account.
3. Credit notes raised from returns must transmit to the fiscal device / eTIMS
   pipeline exactly once, referencing the original invoice's fiscal document.
4. Extend the pgTAP suite: sell at rate A, change the product's tax rate, return,
   and assert the reversed tax equals A and the output-tax control account nets
   to zero on a full return.

**Rules for this domain.** Never reintroduce client-side inserts into
`sales_returns`/`sales_return_items`, client status writes, or a second restock
path. Cost basis comes from `resolve_sales_return_line_cost`; settlement truth
comes from `v_sales_return_settlement`. All journal effects go through
`post_journal_entry_atomic` (ADR 0123).
