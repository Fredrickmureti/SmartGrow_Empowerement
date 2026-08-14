# Warehouse — Product & Inventory Consumer Audit / Reconstruction

Warehouse is the **physical execution layer**. It consumes the canonical Product
(`products`, `product_packaging`) and Inventory (`stock_movements`, `stock_quants`,
cost layers) foundations and never recreates them. All quantity, costing and ledger
authority is server-side.

---

## Verification of the previous engineer's claims (this pass)

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — server-side UoM conversion | **CONFIRMED** | Live DB has `wms_to_base_qty(product_id, packaging_id, qty)`; `wms_capture_receiving_line`, `wms_capture_return_line`, `record_count` all carry `p_packaging_id` / `p_entered_qty` (+ `p_entered_damaged_qty` on receiving); `wms_replay_guarded_call(p_rpc, p_args, …)` present for offline replay |
| Phase 1 guard test | **CONFIRMED** | `src/test/architecture/wms-server-authoritative-uom.test.ts` — 8/8 passing |
| Phase 2 items 1–3 (desktop capture parity, entered-qty on review) | **CONFIRMED** at the contract level (`get_count_lines` redefined, packaging params reach the RPCs) |
| Phase 2 item 4 (unit labels via the Product foundation) | **NOT STARTED** | 21 warehouse `.tsx` surfaces render quantities; **0** import `@/lib/inventory/formatQty` or `@/lib/packagingRollup`. Receiving/counts render bare unitless numbers, e.g. `{Number(l.expected_qty ?? 0)}` |
| Phase 4 precondition (no direct stock-table writes from Warehouse) | **PARTIALLY VERIFIED — favourable** | No `.insert/.update/.upsert/.delete` against `stock_movements`, `stock_quants`, `warehouse_stock*`, `cost_layers`, `stock_lots`, `stock_serials` anywhere in `src/features/warehouse`, `src/apps/warehouse`, `src/pages`. Server-side RPC bodies not yet audited |
| Task/LPN FSM substrate exists | **CONFIRMED** | `wms_claim_next_task`, `wms_transition_task`, `wms_transition_lpn`, `wms_task_heartbeat`, `wms_task_reap_expired`, `wms_lpn_dispatch` all live |

No completed work needs redoing. Resume at **Phase 2 item 4**.

---

## Phase 2.4 — ACTIVE: unit truth on every warehouse quantity render

Problem: warehouse operators see base-unit integers with no unit at all. A line
received as "10 Bags" displays as `500`. The conversion is now correct server-side
(Phase 1) but the presentation layer lost the unit, which is exactly how operators
mis-key the next count.

Work:
1. Add a warehouse-facing display helper that wraps the canonical
   `formatQty` / `packagingRollup` (no new maths — pure delegation) and resolves
   packaging rows through the existing `useProductPackagingBatch`.
2. Migrate the quantity-rendering warehouse surfaces to it, dependency-ordered:
   receiving (`ReceivingSessionWorkspace`, `ReceivingSessionBoard`), counts,
   returns (`ReturnLinesPanel`, `ReturnWorkspace`), putaway, replenishment,
   LPN/handling-unit previews, location overview.
3. Extend the architecture guard so a warehouse `.tsx` that renders a base quantity
   must route through the canonical formatter, and hardcoded unit strings
   (`ea`, `pcs`, `units`) are rejected.

Done when: every listed surface shows entered qty + unit and base qty, the guard
test fails on a deliberate regression, and typecheck is clean.

## Phase 3 — Product foundation consumption audit
Prove Warehouse reads tracking mode, shelf-life, dimensions/weight, hazmat and
lifecycle status from canonical product tables — no shadow columns on `wms_*`.
Park/remove duplicated product metadata found on warehouse tables.

## Phase 4 — Inventory ledger consumption audit
Client side is already clean. Audit the **server** side: read every `wms_*` function
body that touches stock and confirm it calls the sanctioned ledger primitives
(`wms_lpn_dispatch`-style) rather than writing `stock_movements` / `stock_quants`
inline. Pin the result with pgTAP structural guards, as
`supabase/tests/wms_dispatch_relieves_inventory_test.sql` already does for dispatch.

## Phase 5 — Concurrency & server authority verification
Confirm the FSM RPCs are the *only* writers of `state` (no surviving
`.update({ state })` in page code — ADR 0101 flagged this as a Phase 1.3 sweep that
may never have run), that `p_row_version` is threaded from every caller, and that
task claiming uses `FOR UPDATE SKIP LOCKED` leases with heartbeat/reap wired to a
real scheduler rather than a manual button.

## Phase 6 — Handling unit vs product packaging separation
Verify `wms_license_plates` models a physical container (Pallet PAL-001 holding
20 bags) and does not re-encode the reusable `product_packaging` definition.

## Phase 7 — Costing & valuation seam
Landed cost, quarantine and damage dispositions route to canonical costing
functions; no warehouse-local valuation.

Out of scope this wave: Yard (no Product/Inventory dependency established),
Workforce beyond confirming the enterprise identity is consumed, 3PL billing.

---

## Technical notes

- Canonical display API: `formatQtyAsPacks` / `formatQtyWithPacks` /
  `formatBaseQty` in `src/lib/inventory/formatQty.ts`; packaging rows via
  `useProductPackagingBatch` (already returns `product_packaging.id`).
- Existing guard to model the new one on:
  `src/test/architecture/qty-display-uses-formatter.test.ts` (scoped to
  products/inventory today — the warehouse scope is what's missing).
- No migration is expected for Phase 2.4; it is presentation-only.
