## Where we are today

**File map (verified in repo + DB):**
- UI: `src/pages/inventory/PhysicalCount.tsx` — a 3-step wizard (scope → count → review) that assembles a JSON payload and calls `apply_physical_count_atomic` in one shot.
- RPC: `public.apply_physical_count_atomic(p_org, p_business, p_warehouse, p_user, p_lines jsonb)` (last defined in migration `20260423094116`). It creates a `stock_adjustments` row already `status='approved'`, inserts `stock_adjustment_items`, `stock_movements` (`movement_type='count'`), and posts a single lump-sum JE (`source_type='physical_count'`, `status='posted'`).
- No dedicated `physical_counts` / `physical_count_lines` tables exist. The "count" lives entirely in the browser until Post.
- The RPC runs inside a schema loaded with real enterprise guards it does not honour: `trg_stamp_scope_stock_adjustments`, `enforce_branch_business_match`, `enforce_org_write_lock`, `trg_cascade_branch_stock_adjustment_items`, `enforce_line_uom_consistency`, `_uom_normalize_adj_line`, `enforce_stock_movement_provenance`, `_stamp_default_movement_uom`, `validate_stock_movement_quantity`, `_maintain_cost_layers`, `_maintain_warehouse_stock_lots`, `set_normalized_journal_source_type`, `validate_journal_entry_scope`, `validate_fiscal_period_for_journal_entry`, `trg_je_enforce_balanced`, `enforce_je_line_company_match`, `guard_stock_adjustment_self_approval`, `guard_journal_entry_self_approval`, `prevent_approved_adjustment_mutation`, plus the constraint trigger `trg_validate_business_txn_account_types`.

**Why the 400 fires (root cause, not symptom).** The RPC is a batch write into a schema whose invariants it doesn't satisfy. The current insert path can fail on any of:
1. `validate_fiscal_period_for_journal_entry` — no open fiscal period covers `CURRENT_DATE` for the tenant, so the JE header insert raises. Physical counts are frequent on the first business day of a new period → this is the most probable production trigger.
2. `set_normalized_journal_source_type` + `validate_journal_entry_scope` — `'physical_count'` is not in the normalized source-type set and no `journal_book_id` is supplied.
3. `enforce_line_uom_consistency` / `_uom_normalize_adj_line` on `stock_adjustment_items` — RPC doesn't populate the UoM columns (uom_id, quantity_in_base_uom) the trigger requires.
4. `enforce_stock_movement_provenance` — when the product has packagings, movement rows must carry `source_packaging_id`.
5. `_maintain_cost_layers` — a negative-variance line with no available FIFO/WAC layers in that warehouse raises.
6. `enforce_branch_business_match` — the warehouse's `branch_id` does not match `p_business_id` when the caller is scoped to a different business.
7. `trg_je_enforce_balanced` fires on the header with `total_debit=total_credit=0` — passes, but `enforce_je_line_company_match` will reject the JE lines if `resolve_default_account('inventory'|'inventory_adjustment')` returns accounts stamped to a different business.

Each of these returns "400 Bad Request" from PostgREST with a wrapped Postgres exception. Adding null-checks or catching them hides the real problem: the RPC is bypassing the platform's ledger contract.

**Architectural gaps (against SAP/Oracle/Dynamics/Odoo).**
- No first-class **Physical Count document**. There is no `physical_counts` header, no `physical_count_lines`, no state machine (`draft → counting → counted → in_review → approved → posted → cancelled`), no lock/freeze semantics, no recount, no assignment, no cycle-count/full-count distinction, no ABC scope, no snapshot of `system_qty` at freeze time.
- **Snapshot vs. movements-during-count**: `system_qty` is read once in the browser and posted much later. Any sale, receipt, or transfer in between silently corrupts the variance. Enterprise systems freeze bins or capture a movement watermark and reconcile on post.
- **Maker/checker & tolerance**: RPC self-approves in the same transaction (`created_by = approved_by`). SoD guards only cover UPDATE, not the create-as-approved bypass. No variance-value or variance-% tolerance rules; no forced recount above threshold.
- **Financial preview**: users post blind. No JE preview, no per-line valuation impact, no per-warehouse breakdown before commit.
- **Costing correctness**: shrinkage should consume actual FIFO/WAC layers or lots (lot-tracked products need lot selection), surplus should create a new cost layer priced against a policy (last cost / standard / WAC). Today all lines use `products.cost_price` as a scalar.
- **Ledger design**: one lump-sum JE for the whole count is unauditable. Enterprise systems post either per-line or per-warehouse+account with drill-down, and tag the JE with `source_type='inventory_adjustment'` + `source_subtype='physical_count'` + `journal_book_id` for the Inventory journal.
- **Reversal / cancellation**: no reverse-count path, no `superseded_by`. Approved adjustment mutation is blocked by `prevent_approved_adjustment_mutation`, so a mistake today is unrecoverable.
- **Reservations & availability**: variance does not consult `stock_reservations`; posting a shortage can drive `warehouse_stock` below reserved qty without warning.
- **Audit**: no per-line audit (who counted, when, device, scan trail), no session/count-sheet, no immutable variance history separate from the ledger row.

## What we will build

We are going to model the whole Physical Count lifecycle as a first-class business event with its own aggregate, state machine, freeze semantics, and audit — then let the existing ledger/costing invariants do their job (instead of the RPC pretending they don't exist).

### D1 — Physical Count aggregate + state machine (schema)
New tables (all with GRANTs, RLS, org/business/branch scoping, updated_at triggers):
- `physical_counts` — header: `count_number` (Inventory sequence), `warehouse_id`, `count_type` (`full | cycle | spot | abc`), `scope` jsonb (product filter, ABC class, category, location), `state` (`draft | counting | counted | in_review | approved | posted | cancelled | superseded`), `frozen_at`, `frozen_by`, `posted_at`, `posted_by`, `approved_at`, `approved_by`, `tolerance_pct`, `tolerance_value`, `journal_book_id`, `source_count_id` (recount pointer), `notes`, `attachments`.
- `physical_count_lines` — `product_id`, `packaging_id`, `lot_id`, `bin_id` (nullable), `system_qty_at_freeze`, `counted_qty` (nullable until entered), `recount_qty`, `variance_qty`, `variance_value`, `unit_cost_snapshot`, `cost_source` (`fifo|wac|last|standard`), `status` (`pending|counted|variance|matched|recount_required|approved|rejected`), `counted_by`, `counted_at`, `device_id`, `scan_events` jsonb.
- `physical_count_events` — append-only audit stream: `event_type` (`created|frozen|line_counted|recount_requested|submitted|approved|rejected|posted|cancelled|superseded`), `actor_id`, `payload`.
- `physical_count_freeze_movements` — watermark rows capturing `stock_movements.id` at freeze time per (warehouse, product) so post-freeze movements are reconciled into variance at post time.
- `physical_count_tolerance_policies` — per business/warehouse/category tolerance rules (variance pct, variance value, require-recount, require-manager-approval, freeze-required).

Every table has explicit `GRANT SELECT/INSERT/UPDATE ON … TO authenticated`, `GRANT ALL … TO service_role`, `ENABLE ROW LEVEL SECURITY`, org/business/branch scoping policies, and immutability triggers after `posted`/`cancelled`.

### D2 — Lifecycle RPCs (replace the monolithic RPC)
Split the one broken RPC into a proper transactional flow:
- `physical_count_create(warehouse, type, scope, tolerance)` → draft.
- `physical_count_freeze(count_id)` → snapshots `warehouse_stock` into `physical_count_lines.system_qty_at_freeze`, records `physical_count_freeze_movements` watermark, sets `state='counting'`. Optionally reserves bins via `stock_reservations` (`reservation_type='physical_count'`) so double-freeze is impossible.
- `physical_count_record_line(count_id, product_id, packaging_id, lot_id, counted_qty, device_id, scan_ref)` → per-line write; recomputes variance and status.
- `physical_count_submit(count_id)` → `state='counted' → in_review`; evaluates tolerance policies; flips any lines above threshold to `recount_required`.
- `physical_count_request_recount(count_id, line_ids[])` → resets those lines, keeps state `counting`.
- `physical_count_approve(count_id)` → SoD-enforced: `auth.uid() <> created_by AND <> frozen_by` unless a `self_action_override` exists. Uses the existing `guard_stock_adjustment_self_approval`/`self_action_policy` machinery.
- `physical_count_post(count_id)` — the real posting:
  1. Reconciles freeze-window movements (adds them to `system_qty_at_freeze` before computing final variance).
  2. Resolves per-line cost via cost-layer/WAC helpers (`get_available_stock`, cost-layer readers) — not from `products.cost_price`.
  3. Creates one `stock_adjustments` per warehouse (already-supported branch cascade) with `status='draft'` first, then updates to `approved` in the same tx so `guard_stock_adjustment_self_approval` runs correctly.
  4. Inserts `stock_adjustment_items` with full UoM columns (`_uom_normalize_adj_line` happy).
  5. Inserts `stock_movements` with `movement_type='adjustment'`, `source_packaging_id`, `lot_id` when applicable — satisfies `enforce_stock_movement_provenance`, `_maintain_cost_layers`, `_maintain_warehouse_stock_lots`.
  6. Builds the JE via a new helper `post_inventory_adjustment_je(adjustment_id)` that picks the Inventory `journal_book_id`, uses `source_type='inventory_adjustment'`, `source_subtype='physical_count'`, and posts per-warehouse debit/credit rows. Fiscal-period lookup uses `entry_date := COALESCE(open_period_end, CURRENT_DATE)` and raises a **typed** "close period first" error, not a raw 400.
  7. Flips `state='posted'`, writes `physical_count_events`, emits domain event `inventory.physical_count.posted`.
- `physical_count_cancel(count_id, reason)` and `physical_count_supersede(count_id, replacement_id)` — reversal path. Cancellation of a posted count creates the mirror-sign `stock_adjustments` + reversing JE (`is_reversal=true`, `reversal_of_id`) rather than mutating history.

The old `apply_physical_count_atomic` is kept as a compatibility shim for one release that just calls `physical_count_create → freeze → record_line* → submit → approve → post` inside a single tx, so the current UI keeps working while it's rewired.

### D3 — Inventory Manager workspace (UI)
Replace the current one-shot wizard with a persistent workspace:
- New route `/inventory/physical-counts` (list): tabs Draft / Counting / In review / Approved / Posted / Cancelled. Each row: warehouse, type, scope, variance value, financial impact, largest single variance, age, owner.
- Route `/inventory/physical-counts/:id`: header with state chip and SoD-aware action bar (Freeze, Submit, Approve, Request recount, Post, Cancel), lines table with counted/system/variance/value columns and inline recount, variance-review panel (grouped by category, ABC class, top N variances), **JE preview** panel (per-warehouse debit/credit, target accounts resolved live), **valuation impact** panel (cost source per line, WAC delta), audit tab (event stream), attachments tab, drill-downs to `stock_movements`, `journal_entries`, `warehouse_stock`.
- Keep the counting screen as `/inventory/physical-counts/:id/count` — the same wizard UX but now writing per-line via `physical_count_record_line` (auto-save, scanner-driven, offline-safe).
- Everything is gated by permission group `inventory.physical_count.*` (existing governance table).

### D4 — Cross-module invariants
- Reservations: `physical_count_freeze` creates soft reservations so any concurrent sale/transfer raises "in physical count" (not silent contamination). `post` releases them.
- Availability & replenishment: after post, `product_reorder_rules` recomputes on the affected warehouses; `check-inventory-alerts` edge function re-evaluates.
- Sales/POS/manufacturing: nothing to change beyond honouring the reservation.
- Costing: shrinkage consumes cost layers; surplus creates a new layer at chosen `cost_source`. WAC recomputed via existing `update_weighted_avg_cost_on_receipt` for positive variances.
- Domain events: `inventory.physical_count.frozen | submitted | approved | posted | cancelled` on `business_event_outbox` so accountant/warehouse/BI stay in sync.

### D5 — Guardrails, retirement, verification
- Deprecate `apply_physical_count_atomic` after one release (shim logs a `deprecation` row into `commercial_audit_logs`).
- Vitest architecture tests:
  - No client-side JE inserts for physical counts.
  - `physical_count_post` is the only writer of `stock_adjustments.reason='Physical Count'`.
  - RPC signatures typed against `types.ts` (extend the existing `stock-adjustment-rpc-types.test.ts` pattern).
  - No hard-coded `cost_price` reads in the posting path.
- Playwright end-to-end:
  1. Freeze → concurrent POS sale → sale blocks with reservation error.
  2. Count with variance below tolerance → auto-approve path.
  3. Count with variance above tolerance → recount → approve → post → JE visible, drill-down works.
  4. Post on closed fiscal period → typed error, not a 400.
  5. Cancel posted count → reversing JE, movements mirror-sign.
- Supabase linter run + fix any new findings.

### Execution order
D1 (schema) → D2 (RPCs + shim) → D3 (workspace UI, keep wizard as its child) → D4 (cross-module) → D5 (guardrails + tests). One migration per deliverable, each with GRANTs + RLS in the same file. No touching of unrelated modules; no country-specific logic anywhere in this pipeline (fully platform-core).

## Technical notes

- The 400 is fixed as a side-effect of D2 posting through valid paths, not by suppressing the exceptions. Typed errors surface via `raise exception using errcode='P0001', message='...', hint='...'` so the UI can render actionable toasts (e.g. "Open a fiscal period for 2026-07 first").
- We reuse existing infrastructure everywhere: `journal_books`, `self_action_policy` + `self_action_overrides`, `stock_reservations`, `cost_layers`, `warehouse_stock_lots`, `business_event_outbox`, `commercial_audit_logs`, `product_reorder_rules`, `check-inventory-alerts`. No parallel implementations.
- `stock_movements.movement_type` becomes `'adjustment'` (not `'count'`) so the WAC / cost-layer / product-stock triggers actually fire — today `'count'` is silently ignored by `update_weighted_avg_cost_on_receipt` and can be ignored by other listeners.
- All new tables carry `organization_id`, `business_id`, `branch_id` and rely on `stamp_scope_from_warehouse` + `enforce_branch_business_match` so branch integrity is guaranteed with zero duplicated logic.
