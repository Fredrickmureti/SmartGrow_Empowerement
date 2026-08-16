# Landed Cost Domain — Reconstruction Roadmap (live status)

Last updated: 2026-08-16 (handoff verification) · Active phase: **B (in progress)**

## Verification of the previous session (done, live database)

Confirmed directly against the live database, not from notes:

- `public.cost_layer_lineage` exists (0 rows — never exercised).
- `_maintain_cost_layers` references lineage; `inventory_cost_layer_descendants`
  exists as a single function; `inventory_apply_cost_revaluation` calls the
  tracer and returns `transferred_qty`; `inventory_cost_revaluations` carries
  `warehouse_id`.
- `inventory_reverse_cost_revaluation` still unwinds on `qty_remaining_at_apply`
  but makes **no reference to `warehouse_id`** — the reversal path has not been
  reviewed for the multi-warehouse case the apply path now creates.
- `stock_transfers` is empty and `check_inventory_valuation_drift()` returns no
  rows; 1 voucher exists.

Verdict: Phase B item 1 is **code-complete but unverified**, exactly as the
previous engineer stated, with one added open question (reversal per warehouse).

## Phase A — Full lifecycle execution — DONE, VERIFIED

Voucher `LCV-2026-00001` (KES 74 duty, value basis) driven end to end over the
live Sugar receipt (500 received, 152 already sold).

- Allocation: 74.00 spread over the receipt line, deterministic, rounding absorbed.
- Posting: 51.50 capitalised / 22.50 expensed, balanced JE-00019 through
  `post_journal_entry_atomic`, gated by `approval_route`.
- Reversal: compensating journal, layer restored, original journal preserved.
- Defect fixed: capitalisation moved cost layers but not AVCO →
  `inventory_sync_avco_from_layers` + `trg_inventory_revaluation_avco_sync`,
  both registered as valuation writers (ADR 0078 single-writer rule intact);
  existing drift repaired; drift check given a rounding tolerance for the
  2-decimal `products.cost_price`.
- Defect fixed: `procurement.landed_cost.*` events dead-lettered as
  `unknown_event_type` → handlers registered in `outbox-dispatcher`, function
  deployed, both stuck events reprocessed (`succeeded`).
- Write-up: `docs/audit/2026-08-16-landed-cost-lifecycle-execution.md`.

## Phase B — Edge cases: movement between receipt and reversal — IN PROGRESS

### Done and verified

**Stock sold between posting and reversal.** Two defects found by reading the
engines and fixed in one migration:

1. `inventory_reverse_cost_revaluation` unwound using the layer's *current*
   `qty_remaining` instead of `qty_remaining_at_apply`, under-costing the
   surviving stock (0.0597/unit in the live scenario) and doing nothing at all
   for a fully consumed layer. It now subtracts the exact per-unit uplift and
   returns the `unwound` / `consumed` / `by_product` split.
2. `landed_cost_reverse_voucher` mirrored the original journal, crediting
   Inventory for value inventory no longer held. It now *builds* the reversal:
   Inventory credited for the unwound portion, COGS for the portion sold since
   posting plus the portion already expensed at posting, expense accounts for
   non-capitalisable charges, Landed Cost Clearing debited with the total.

Verified live in a rolled-back rehearsal (clone voucher, post, consume 100
units, reverse): layer 2.4000 → 2.5480 → 2.4000 exactly; journal
`Dr Clearing 74.00 / Cr Inventory 36.70 / Cr COGS 22.50 / Cr COGS 14.80`,
balance 0.00; nothing persisted; `check_inventory_valuation_drift()` clean.

Ratchet: `supabase/tests/landed_cost_reversal_split_test.sql`.
Write-up: `docs/audit/2026-08-16-landed-cost-reversal-split.md`.

### Pending in Phase B (next work)

1. **Inter-warehouse transfer before posting** — code landed (lineage table,
   lineage capture in `_maintain_cost_layers`, `inventory_cost_layer_descendants`,
   warehouse-stamped revaluation rows). Remaining work, in order:
   a. Rolled-back rehearsal that creates a real `stock_transfers` +
      `stock_transfer_items` pair (or drives `approve_stock_transfer_atomic` /
      `complete_stock_transfer_atomic`) inside the aborted transaction, so
      `enforce_stock_movement_integrity` stops refusing the transfer legs with
      `INVENTORY_DANGLING_PROVENANCE`. Then clone the voucher, post, and confirm
      the full 51.50 capitalises across HQ 248 + destination 100 (not 36.70),
      reversal restores both layers exactly, and
      `check_inventory_valuation_drift()` stays clean in both scopes.
   b. Confirm the reversal path handles the destination warehouse: the apply
      path now stamps `warehouse_id` per layer, while
      `inventory_reverse_cost_revaluation` never reads it. If AVCO restoration
      or the reversal journal split collapses transferred stock into the origin
      warehouse, fix it in the canonical revaluation engine.
   c. Ratchet `supabase/tests/landed_cost_transfer_lineage_test.sql`
      (lineage capture, tracer single-overload, apply uses the tracer, per-layer
      warehouse stamping, no orphan lineage rows).
   d. Write-up `docs/audit/2026-08-16-landed-cost-transfer-lineage.md`.
2. **Goods receipt reversal / return to supplier** after a landed cost is
   allocated or posted — currently unguarded; decide between blocking the
   receipt reversal and auto-reversing the voucher.
3. **Supplier credit note against a landed-cost bill** — adjust or reverse-and-
   re-post the voucher; must not double-count clearing.

## Phase C — Cleanup — PENDING

Retire `landed_cost_selftest` and `landed_cost_selftest_run` (superseded by the
SQL ratchets in `supabase/tests/`).

## Phase D — Physical allocation bases — PENDING (deliberately blocked)

Weight / volume bases stay refused until the product master carries canonical
dimensions. Keep the refusal explicit and message-clear.

## Phase E — Workspace UX — PENDING

Surface operational status in the landed-cost workspace from the server-side
reporting RPCs (`landed_cost_receipt_summary`, `landed_cost_clearing_exposure`,
`landed_cost_valuation_attribution`) — no client-side aggregation.

---

## Instructions for the next agent

1. **Rehearse destructively without persisting.** The pattern used here:
   a `DO $$ ... $$` migration that clones the voucher, exercises the lifecycle,
   and ends in `RAISE EXCEPTION` so the whole transaction rolls back while the
   results come back in the error text. Note `post_journal_entry_atomic`
   deduplicates by `(source_type, source_id)` — always rehearse on a cloned
   voucher id, never on one that already has journal history.
2. Resume at Phase B item 1 sub-steps (a) → (d), then items 2 and 3. No new
   engines: transfers, valuation, journals, approvals and events stay canonical.
3. Keep this file current after every completed implementation.
