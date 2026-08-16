# Landed Cost Domain — Reconstruction Roadmap (live status)

Last updated: 2026-08-16 · Active phase: **B (in progress)**

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

1. **Inter-warehouse transfer before posting** — `inventory_apply_cost_revaluation`
   matches layers on the receipt's warehouse only, so transferred stock is
   expensed to COGS instead of capitalised at the destination. Needs layer
   lineage across transfers. No live data exercises this yet.
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

1. **Verify Phase B's committed work before writing anything new.** Read
   `docs/audit/2026-08-16-landed-cost-reversal-split.md`, then confirm against
   the live database: `inventory_reverse_cost_revaluation` uses
   `qty_remaining_at_apply`; `landed_cost_reverse_voucher` builds its lines and
   still routes through `post_journal_entry_atomic`; no reversed voucher has
   open `inventory_cost_revaluations`; every `landed_cost_voucher` journal
   balances; `check_inventory_valuation_drift()` returns no rows. Run
   `supabase/tests/landed_cost_reversal_split_test.sql` and
   `supabase/tests/landed_cost_hardening_test.sql`.
2. **Rehearse destructively without persisting.** The pattern used here:
   a `DO $$ ... $$` migration that clones the voucher, exercises the lifecycle,
   and ends in `RAISE EXCEPTION` so the whole transaction rolls back while the
   results come back in the error text. Note `post_journal_entry_atomic`
   deduplicates by `(source_type, source_id)` — always rehearse on a cloned
   voucher id, never on one that already has journal history.
3. **Then resume at Phase B item 1** (transfer-before-posting layer lineage),
   not at an unrelated area. Finish Phase B's three items before Phase C.
4. Keep this file current after every completed implementation.
