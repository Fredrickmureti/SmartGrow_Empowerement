# Landed Cost Domain — Reconstruction Roadmap (live status)

Last updated: 2026-08-16 · Active phase: **B (in progress)**

## Phase A — Full lifecycle execution — DONE, VERIFIED

See `docs/audit/2026-08-16-landed-cost-lifecycle-execution.md`. Allocation,
posting (capitalised/expensed split, balanced journal through
`post_journal_entry_atomic`) and reversal all driven end to end on live data.
Two defects fixed: AVCO was not moved by capitalisation, and landed-cost outbox
events were dead-lettered.

## Phase B — Edge cases: movement between receipt and reversal — IN PROGRESS

### Done and verified

**Stock sold between posting and reversal.** `inventory_reverse_cost_revaluation`
now unwinds against `qty_remaining_at_apply` and reports the
inventory/COGS split; `landed_cost_reverse_voucher` builds its reversal journal
from that split instead of mirroring the original.
Ratchet `supabase/tests/landed_cost_reversal_split_test.sql`;
write-up `docs/audit/2026-08-16-landed-cost-reversal-split.md`.

**Inter-warehouse transfer before posting.** Three defects, each in a different
canonical engine, made this impossible:

1. `stock_movements_movement_type_check` rejected `transfer_out` / `transfer_in`
   (and `adjustment_in/out`, `opening_stock`, `customer_return`,
   `vendor_return`) although 10+ engines emit them — every transfer in the
   product failed at approval. Constraint widened to the engine vocabulary and
   the missing types registered in `inventory_movement_event_classes`.
2. The business transit location had `warehouse_id IS NULL`, so dispatched stock
   projected onto no warehouse (ADR 0142) and receiving failed with
   "Available: 0". `get_business_transit_location` now scopes it to the
   `is_in_transit` warehouse.
3. Transfer legs carry no `unit_cost`, so destination layers were created at
   0.00. `_maintain_cost_layers` now inherits the quantity-weighted cost of the
   parent consumptions and re-derives destination AVCO through
   `inventory_sync_avco_from_layers` (registered writer, ADR 0078 intact).

Rehearsed and rolled back: after transferring 100 of 348 on-hand units, posting
capitalised 51.50 across both warehouses (HQ 36.70 / destination 14.80),
expensed 22.50 for the 152 already sold, journal 74/74 balanced, zero valuation
drift. `inventory_apply_cost_revaluation` already followed lineage across
warehouses — what was missing was a working transfer and a cost to follow.

Ratchet: `supabase/tests/landed_cost_transfer_lineage_test.sql`.
Write-up: `docs/audit/2026-08-16-landed-cost-transfer-lineage.md`.

**Goods receipt reversal / return to supplier.** Neither `void_goods_receipt_atomic`
nor any `purchase_return_*` command knew about landed cost, so capitalised
charges would have stayed in inventory after the stock left. Decision: **block,
never auto-reverse** — a posted voucher is an approved accounting document with
its own governance route.

- `landed_cost_receipt_encumbrance` is the single authority for "does this
  receipt still carry landed cost"; `landed_cost_receipt_block_reason` renders
  the operator sentence and `landed_cost_assert_receipt_unencumbered` is the
  hard guard.
- `resolve_reversal_intent` is *annotated, not forked*:
  `_landed_cost_annotate_reversal_intent` decorates the finance authority's
  goods_receipt verdict (disallows `goods_return`, adds the
  `landed_cost_encumbered` blocker, recommends `reverse_landed_cost`).
  `void_goods_receipt_atomic` inherits the block through `assert_can_reverse`.
- `purchase_return_create` guards at draft time, `purchase_return_dispatch`
  re-guards at the moment stock leaves.
- Defect fixed: `purchase_return_dispatch` emitted `movement_type = 'return'`,
  which the movement vocabulary forbids and neither cost-layer branch consumes —
  returns could not dispatch at all, and would not have relieved inventory value
  if they had. Now `vendor_return`, consumed at layer cost (landed cost
  included), with AVCO re-derived via `inventory_sync_avco_from_layers`.

Verified live and rolled back: a posted voucher yields `encumbered=true`, the
assert raises, `goods_return` becomes disallowed and `reverse_landed_cost` is
recommended; the voucher remains `reversed` afterwards.

Ratchet: `supabase/tests/landed_cost_receipt_reversal_guard_test.sql`.
Write-up: `docs/audit/2026-08-16-landed-cost-receipt-reversal-guard.md`.

### Pending in Phase B (next work)

1. **Supplier credit note against a landed-cost bill** — adjust or reverse-and-
   re-post the voucher; must not double-count clearing.
   This is the last Phase B item; Phase C follows.

## Phase C — Cleanup — PENDING

Retire `landed_cost_selftest` and `landed_cost_selftest_run` (superseded by the
SQL ratchets in `supabase/tests/`).

## Phase D — Physical allocation bases — PENDING (deliberately blocked)

Weight / volume bases stay refused until the product master carries canonical
dimensions.

## Phase E — Workspace UX — PENDING

Surface operational status in the landed-cost workspace from the server-side
reporting RPCs (`landed_cost_receipt_summary`, `landed_cost_clearing_exposure`,
`landed_cost_valuation_attribution`) — no client-side aggregation.

---

## Instructions for the next agent

1. Verify committed work first: run
   `supabase/tests/landed_cost_transfer_lineage_test.sql`,
   `supabase/tests/landed_cost_reversal_split_test.sql` and
   `supabase/tests/landed_cost_hardening_test.sql`, and confirm
   `check_inventory_valuation_drift()` returns no rows.
2. `supabase--read_query` runs as a role without EXECUTE on the new
   `landed_cost_receipt_*` helpers, so exercise them from a migration, not a
   query.
3. Rehearse destructively without persisting: a `DO $$ ... $$` migration that
   clones the voucher, exercises the lifecycle and ends in `RAISE EXCEPTION` so
   everything rolls back while results come back in the error text. Clone the
   voucher (`post_journal_entry_atomic` deduplicates by
   `(source_type, source_id)`) and give the clone a different `created_by` than
   the posting actor, or `guard_landed_cost_self_approval` refuses.
   `landed_cost_reverse_voucher` needs an authenticated caller (`auth.uid()`),
   so reversal cannot be rehearsed from a migration — use `_landed_cost_post_apply`
   for the posting half.
4. Then resume at Phase B item 1 above (supplier credit note against a
   landed-cost bill): decide between adjusting the voucher in place and
   reverse-and-re-post, and make sure Landed Cost Clearing is not double
   counted. `vendor_credit_note` already has its own reversal intent resolver —
   annotate it the same way rather than forking it.
5. Keep this file current after every completed implementation.
