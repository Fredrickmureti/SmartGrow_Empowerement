# Landed Cost Domain — Reconstruction Plan & Status

**Authoritative status file.** Update after every implementation step.

## Domain definition (settled)

A **Landed Cost Voucher** accumulates acquisition charges (freight, insurance, duty,
clearing, handling, demurrage) and capitalises them onto the stock received on one or
more Goods Receipts. It is a *value-only* event: quantities never change.

Lifecycle: `draft → (pending_approval) → allocated → posted → reversed | cancelled`.

Accounting on post:
```text
Dr Inventory              capitalised share (stock still on hand)
Dr Cost of Goods Sold     share belonging to stock already sold
Dr <expense account>      non-capitalisable charges (e.g. demurrage)
    Cr Landed Cost Clearing   total charge (base currency)
```
The supplier bill for the charge posts `Dr Landed Cost Clearing / Cr AP`, so the
clearing account nets to zero once both sides exist.

---

## Phase status

### Phase 1 — Inventory valuation foundation — ✅ DONE
- `inventory_cost_revaluations` provenance table (RLS, grants, idempotency index).
- `inventory_apply_cost_revaluation(gri, amount, source_type, source_id, actor)`:
  value-only unit-cost uplift on the cost layers of a receipt line, proportional to
  `qty_remaining`; returns the capitalised/expensed split; rounding drift absorbed.
- `inventory_reverse_cost_revaluation(source_type, source_id, actor)` — exact unwind.
- Fixes the original defect: the old code wrote `stock_movements` with `quantity = 0`,
  which `_maintain_cost_layers` short-circuits, so landed cost had **zero** effect on AVCO.

### Phase 2 — Domain model — ✅ DONE
- Dropped the empty legacy `landed_cost_bills` / `landed_cost_allocations` and the three
  legacy RPCs. `bill_match_results.landed_cost_bill_id` re-pointed at the voucher;
  `match_bill_atomic` patched in place.
- New tables (all with GRANTs + RLS + updated_at triggers):
  `landed_cost_component_types`, `landed_cost_vouchers`, `landed_cost_components`,
  `landed_cost_allocations`.
- Enums `landed_cost_voucher_status`, `landed_cost_allocation_basis`.
- Auto voucher numbering `LCV-YYYY-#####` per business.
- RLS forbids browser writes to posted/reversed vouchers — status transitions are RPC-only.

### Phase 3 — Allocation engine — ✅ DONE
- `landed_cost_voucher_receipts` (shipment scope).
- `landed_cost_allocate_voucher(voucher, actor)`: eligibility filter
  (`products.track_inventory`, qty > 0), bases `value` / `quantity` / `manual`,
  exact rounding, idempotent re-run, returns skipped lines with reasons.
- `weight` / `volume` bases raise an explicit error — no net weight/volume master data
  exists on `products`. **Open item, see below.**
- Triggers keep `base_amount` (FX-stamped) and voucher totals coherent.

### Phase 4 — Posting & reversal — ✅ DONE
- `landed_cost_post_voucher(voucher, actor)`: period-lock check, account resolution with
  no silent fallbacks, per-receipt-line revaluation, balanced JE via
  `post_journal_entry_atomic` (`source_type = 'landed_cost_voucher'`, dedupe-safe),
  `emit_business_event('landed_cost.posted')`.
- `landed_cost_reverse_voucher(voucher, reason, actor)`: mandatory reason, inventory
  unwind, mirror JE (`source_subtype = 'reversal'`), `landed_cost.reversed` event.
- Seeded `landed_cost_clearing` system account role + 6 starter component types per business.

### Phase 5 — Workspace UI — 🚧 NEXT (active phase)
`src/pages/purchases/LandedCosts.tsx` is currently an **interim read-only list** against
the new model (it compiles and no longer writes statuses from the browser). To build:
- `src/features/landed-costs/` feature folder mirroring the Bills/GRN pattern:
  `hooks/useLandedCostVouchers.ts`, `useLandedCostVoucher.ts` (detail + components +
  allocations), `useLandedCostActions.ts` (allocate / post / reverse via `supabase.rpc`).
- List surface with status filters; record surface on `RecordScaffold` with tabs:
  Charges, Scope (goods receipts), Allocation preview, Accounting (JE link), Audit.
- Peek via `PeekScaffold`; action bar gated by status; reversal reason dialog.
- Component type settings screen (catalog CRUD).
- Register `landed_cost_voucher` in the `document_kinds` registry and the governance
  action registry (`landed_cost.post`, `landed_cost.reverse`).

### Phase 6 — Approvals, matching & reporting — ⏳ PENDING
- Wire `approval_requests` (`approval_request_id` column already exists) for post.
- Surface landed cost uplift inside the 3-way bill match UI.
- Landed cost per receipt/product report + integrity check (clearing account ageing).

---

## Open items / known gaps
1. **Weight & volume bases** need `products.net_weight` / `volume` + UoM master data
   before they can be enabled; engine currently rejects them explicitly.
2. **No end-to-end runtime test yet** — the engines are deployed but have not been
   exercised against a real posted GRN (no landed cost data exists in the database).
3. Approval gating on posting is modelled but not enforced.

---

## Instructions for the next agent

1. **Verify Phases 1–4 before writing new code.** Specifically:
   - Create a throwaway voucher against a real posted GRN in a scratch business, run
     `landed_cost_allocate_voucher`, then `landed_cost_post_voucher`, and confirm:
     allocations sum exactly to the charge; `cost_layers.unit_cost` rose only for
     remaining qty; the JE balances and hits Inventory / COGS / Landed Cost Clearing;
     `inventory_cost_revaluations` has one row per layer.
   - Run `landed_cost_reverse_voucher` and confirm unit costs and the ledger return to
     their prior state and `inventory_cost_revaluations.reversed_at` is set.
   - Confirm posting is refused in a locked fiscal period and when
     `landed_cost_clearing` is unmapped.
2. **Then resume at Phase 5 (Workspace UI)** — do not start Phase 6 or unrelated work
   until Phase 5 is coherent and shippable end to end.
3. Keep this file updated as the single source of truth after each step.
