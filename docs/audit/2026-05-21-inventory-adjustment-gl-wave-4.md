# Inventory adjustment ↔ GL — Wave 4 closeout (re-audit) — 2026-05-21

## Why this wave exists

The previous agent declared Wave 3 closed and claimed "All 15 architecture
tests pass". An independent re-audit found that statement was false and
three additional gaps had not been disclosed. This document records the
verification + remediation that closed them.

## Verified-as-shipped (no changes needed)

Re-verified by grep against the migration set and `src/`:

- Server-side cost resolver, `warehouse_stock.average_cost`, hardened
  `approve_stock_adjustment_atomic` (raises on missing cost, locks row,
  routes GL through `post_journal_entry_atomic`).
- `client_request_id` idempotency column + short-circuit in
  `apply_or_request_stock_adjustment`.
- Header + items immutability triggers
  (`trg_enforce_stock_adjustment_immutability`, items variant).
- Reason-keyed offset accounts via `resolve_adjustment_offset_account`.
- `reverse_stock_adjustment_atomic` (rejects: status≠approved, already
  reversed, self-reversal, locked period).
- `prevent_approved_adjustment_mutation` trigger — allowlist
  (`reverses_adjustment_id`, `reversed_by_adjustment_id` + `approved →
  reversed` transition) re-read and confirmed correct.
- `list_adjustments_missing_journals` + `backfill_missing_adjustment_je`
  RPCs.
- `ReverseAdjustmentDialog` wired into `src/pages/Inventory.tsx` with
  permission gating, lifecycle badges, and `reversed` status badge.
- `MissingAdjustmentJournalsSection` embedded in
  `InventoryReconciliationCard` with per-row "Post JE now".
- ADR 0016 published.

## Gaps the previous agent missed (now closed)

### G1 — CI guard contradicted the new architecture (BLOCKER, fixed)

`src/test/architecture/stock-adjustment-rpc-types.test.ts` asserted the
latest `approve_stock_adjustment_atomic` body MUST contain
`INSERT INTO journal_entries`. The Wave-1 refactor (and the parallel guard
in `inventory-adjustment-posting.test.ts`) deliberately removed that raw
insert and routes posting through `post_journal_entry_atomic`. The two
guards were contradicting each other; CI was red.

Fix: the assertion now requires `post_journal_entry_atomic(...)` to appear
in the RPC body, and explicitly rejects raw `INSERT INTO journal_entries`.
Both directions are now consistent with ADR 0016.

### G3 — Drift was visible only inside the Inventory reconciliation card (fixed)

An approved adjustment that posted no JE used to surface only in the
Finance → Inventory reconciliation card. A tenant who never opened that
card would never learn their inventory subledger had moved without GL.

Fix: migration adds a `accounting_integrity_findings_stock_adjustments`
view and updates `get_accounting_integrity_findings` to UNION it in.
Every such row now appears as a `critical` finding in the Accounting
Integrity panel, automatically picked up by `useAccountingIntegrity`
with no client change.

### G5 — No guard against client-side writes that re-open the defect class (fixed)

Nothing prevented a future hook from calling
`supabase.from('stock_adjustments').update({ status: 'approved', ... })`
directly, bypassing every server-side invariant.

Fix: `src/test/architecture/no-client-stock-adjustment-status-writes.test.ts`
greps every `.from('stock_adjustments').update({...})` payload in `src/`
and fails if any forbidden field appears (`approved_at`, `approved_by`,
`reverses_adjustment_id`, `reversed_by_adjustment_id`, `total_value`,
`client_request_id`, `adjustment_date`, `reason`, `warehouse_id`,
`branch_id`, `business_id`, `organization_id`) or if `status` is set to
anything other than `cancelled` / `rejected`. Client `.upsert()` is
forbidden outright. The renderer-side `cancelStockAdjustment` mutation is
the only sanctioned client write and passes.

### G2 — pgTAP coverage was schema-only (partially closed)

The Wave 3 plan promised 10 behavioural pgTAP scenarios; only schema
existence was shipped.

Fix: `supabase/tests/inventory-adjustment-gl.sql` extended with 4
source-level behavioural assertions that run without a seeded org:

1. `approve_stock_adjustment_atomic` references `post_journal_entry_atomic`.
2. `apply_or_request_stock_adjustment` contains an idempotency short-circuit
   keyed on `client_request_id`.
3. `reverse_stock_adjustment_atomic` raises on already-reversed input.
4. `reverse_stock_adjustment_atomic` raises inside a locked accounting
   period.

The remaining 6 (idempotency replay round-trip, reversal nets-to-zero in
GL, reason-keyed offset account hit, double-backfill raise, immutability
UPDATE rejection, status-transition trigger) need a seeded-org fixture
and are explicitly deferred to a follow-up wave.

## Not closed (deliberate)

- **Full org-seeded pgTAP for the remaining 6 behavioural cases.** Needs a
  shared seeding harness across the audit suite. Tracked as Wave 5.
- **G6 — preview offset account name in the adjustment dialog.** UX-only;
  postponed.
- **Historical multi-currency revaluation entries.** Separate workstream.
- **FIFO/LIFO.** AVCO stands per ADR 0002.
- **Per-lot quants.** Rejected per ADR 0001.

## Migrations added

- `accounting_integrity_findings_stock_adjustments` view +
  `get_accounting_integrity_findings` UNION update.

## Files added / changed

- Changed: `src/test/architecture/stock-adjustment-rpc-types.test.ts`
  (assertion flipped to canonical writer).
- Added: `src/test/architecture/no-client-stock-adjustment-status-writes.test.ts`.
- Changed: `supabase/tests/inventory-adjustment-gl.sql` (+4 behavioural cases).
- Added: this document.
- Updated: `.lovable/plan.md` (Wave 4 closeout).

## Honest CI state at the end of this wave

All 24 inventory-adjustment-related vitest cases across 6 files pass
(`stock-adjustment-rpc-types`, `inventory-adjustment-posting`,
`inventory-adjustment-cost-resolution`, `no-hardcoded-draft-stock-adjustment`,
`stock-adjustment-warehouse-stamp`,
`no-client-stock-adjustment-status-writes`). Project-wide unrelated test
failures exist (warehouse-stock-reads-go-through-helper.test.ts and others
outside the inventory-adjustment / GL domain) — not introduced by this
wave, not in scope.