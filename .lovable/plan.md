# Warehouse (WMS) — Product & Inventory consumer audit, dependency-ordered

Scope governor: only Warehouse areas with a real Product/Inventory dependency.
Yard, docks, trailers, 3PL billing are out of scope unless evidence pulls them in.

---

## Phase 0 · Verify the previous agent's claims (done this session)

| Claim | Evidence gathered | Verdict |
|---|---|---|
| Offline replay unified on one idempotent queue (Phase 3.9) | `src/apps/warehouse-mobile/offlineQueue.ts` is the only `supabase.rpc` path for mobile; every call goes through `wms_replay_guarded_call(p_rpc, p_args, p_client_scan_id, p_device_id)`; `useOfflineScanQueue` has zero callers | Confirmed (dead duplicate file still on disk) |
| Warehouse does not write stock tables from the browser | No `.from("stock_quants"/"stock_movements"/"cost_layers")` mutation anywhere under `src/features/warehouse`, `src/pages/warehouse*`, `src/apps/warehouse*` | Confirmed |
| Dispatch relieves inventory through the ledger | `wms_transition_manifest` → `wms_lpn_dispatch` → `stock_movements` + `stock_quants`, pinned by `supabase/tests/wms_dispatch_relieves_inventory_test.sql` | Confirmed |
| Canonical UoM engine exists and is single | `public.convert_uom(qty, from_uom uuid, to_uom uuid)`, `uom_categories`, `product_packaging(qty_in_base_uom, qty_in_parent, parent_packaging_id)`, `_uom_normalize_line*` triggers | Confirmed — Warehouse must consume, not fork |
| Task model is a real domain entity | `wms_tasks` + `wms_claim_next_task` (`FOR UPDATE SKIP LOCKED`, lease), `wms_task_heartbeat`, `wms_task_reap_expired`, `row_version` optimistic concurrency (ADR 0101) | Confirmed |

**Conclusion:** the Inventory boundary and the concurrency substrate are sound.
The defect is at the **Product/UoM seam**, not the Inventory seam.

---

## Phase 1 · The unit seam is browser-authoritative (ACTIVE — blocks dependents)

**Evidence.**

- `wms_capture_receiving_line(..., p_uom text, ...)` treats `p_uom` as a *label only*
  and raises `22023` if the label names a packaging level with a multiplier:
  *"received_qty must be in base units … convert before capture"*. The server
  refuses to convert.
- The conversion therefore happens in the browser:
  `MobileReceiveSession.tsx` computes `baseQty = toBaseUnits(Number(qty), unit)` and
  `baseDamaged` client-side, then posts the already-multiplied number.
- `MobileCount.tsx` posts `p_counted_qty: n` raw — **no unit selector at all**. An
  operator counting cases records cases as base units. Same for
  `MobileReturns.tsx` (`p_uom: null`).
- `wms_receiving_lines.uom` / `wms_return_lines.uom` are `text`, not a FK to the
  canonical UoM/packaging rows — the audit trail cannot be re-derived or trusted.

**Verdict.** Warehouse consumes the canonical Product packaging *data* but performs the
conversion *math* in the client, violating §6 and §20. Counts and returns have no
packaging path at all, which is a silent quantity-corruption route.

**Implementation.**

1. Migration — packaging-aware capture at the seam:
   - Add `packaging_id uuid REFERENCES product_packaging(id)` and
     `entered_qty numeric` to `wms_receiving_lines`, `wms_return_lines`,
     `wms_count_lines` (base qty columns stay canonical and unchanged).
   - New server helper `wms_to_base_qty(p_product_id, p_packaging_id, p_qty)` —
     a thin delegate over `product_packaging.qty_in_base_uom` / `convert_uom`.
     No new conversion mathematics; it resolves and calls the canonical path.
   - Change `wms_capture_receiving_line`, `wms_capture_return_line` and the count
     capture RPC to accept `p_packaging_id uuid` + `p_entered_qty numeric`,
     convert server-side, persist both entered and base values, and validate that
     the packaging row belongs to the product and the caller's business.
   - Keep the existing base-units parameters as a deprecated path guarded by the
     same `22023` check so nothing in flight breaks.
2. Client — delete the local multiplication:
   - `MobileReceiveSession` sends `{ packaging_id, entered_qty }`; `toBaseUnits`
     stops feeding the RPC and is used for **display preview only**.
   - Add the same unit selector to `MobileCount` and `MobileReturns`.
3. Guards — architecture test asserting no `toBaseUnits(`/`* qty_in_base_uom`
   result is passed into any `wms_*` RPC argument.

**Verification.** pgTAP: capturing 10 × "Bag (50 kg)" yields `received_qty = 500`
and `entered_qty = 10`; wrong-product packaging id is rejected; replay through
`wms_replay_guarded_call` still returns the stored result without a second
conversion.

---

## Phase 2 · Handling unit vs. product packaging (after Phase 1)

`wms_license_plates.packaging_type_id` and `wms_pack_cartons.packaging_type_id`
point at `wms_packaging_types` (warehouse containers), while `product_packaging`
holds the product's own levels. Confirm the two are genuinely separate and that
LPN content quantities are base-unit, then pin it with a guard. No rebuild
expected unless evidence says otherwise.

## Phase 3 · Inbound completion chain re-verification

Trace `wms_capture_receiving_line → session complete → wms_apply_gr_stock →
stock_movements → business_event_outbox` end to end, confirming the base-unit
values written in Phase 1 are what reaches the ledger and that the topics are
registered in `business_event_topics` with the right `handler_scope`
(ADR 0076 addendum).

## Phase 4 · Putaway / replenishment / slotting inputs

Only after Phase 1: confirm the strategy engines read canonical product
attributes (weight, volume, dimensions, storage profile) rather than
warehouse-local copies, and that no second strategy engine exists.

## Phase 5 · Cleanup

Delete the dead `useOfflineScanQueue.ts` duplicate; keep the guard that pins the
single chokepoint.

Not scheduled: Yard, Gate, Trailers, 3PL billing, Labour — no Product/Inventory
dependency surfaced in Phase 0.
