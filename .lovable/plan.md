# Warehouse — Product & Inventory Consumer Audit / Reconstruction

Goal: the Warehouse app is the enterprise **physical execution layer**. It consumes the
canonical Product and Inventory foundations (products, `product_packaging`, stock ledger)
and never recreates them. All quantity, costing and ledger authority lives server-side.

---

## Phase 1 — Server-authoritative unit-of-measure conversion — COMPLETE (verified)

Problem removed: the browser multiplied operator input by a packaging factor before
calling quantity-mutating RPCs, so a stale factor (or an offline replay captured before a
packaging edit) could silently book the wrong base quantity into the stock ledger.

Database (migration applied and verified against the live schema):
- `wms_to_base_qty(product_id, packaging_id, entered_qty)` — canonical converter, reads
  `product_packaging.qty_in_base_uom`.
- `packaging_id` + `entered_qty` columns on `wms_receiving_lines`, `wms_return_lines`,
  `wms_count_lines` (full audit of what the operator actually typed, in which unit).
- `wms_capture_receiving_line`, `wms_capture_return_line`, `record_count` accept
  `p_packaging_id` / `p_entered_qty` (+ `p_entered_damaged_qty`) and convert server-side.
- Guard: passing a packaging UoM *label* with a multiplier > 1 and no `p_packaging_id`
  raises an exception, so no legacy caller can slip through.
- `wms_replay_guarded_call` dispatcher forwards the new parameters (offline replay safe).

Client:
- `useProductPackagingBatch` / `PackForRollup` now carry `product_packaging.id`.
- `receivingUnits.ts` — `ReceivingUnitOption.packagingId`; `toBaseUnits()` demoted to a
  documented **display preview only** helper.
- Mobile: `MobileReceiveSession`, `MobileCount`, `MobileReturns` send
  `{ p_entered_qty, p_packaging_id }`. Count and Returns gained unit selectors, so
  operators can record in cases for the first time.
- Desktop: `ReceivingSessionWorkspace` + `useReceivingLines.useCaptureReceivingLine`
  migrated to the same contract (no client multiplication anywhere on the capture path).

Verification:
- `src/test/architecture/wms-server-authoritative-uom.test.ts` — 8 passing guards
  covering mobile + desktop surfaces and the shared mutation hook.
- Typecheck clean.

Known, accepted scope notes:
- GS1 scan path in `ReceivingSessionWorkspace` uses `baseUnits` resolved by the
  server-side identity gate (`resolve_product_identity`), not browser math — allowed.

---

## Phase 2 — ACTIVE: Desktop capture parity + UoM display truth

1. DONE — desktop `CountSession` has a per-line unit selector and sends
   `p_packaging_id` / `p_entered_qty` (row-level units via `useProductPackagingBatch`).
2. DONE — desktop returns capture (`ReturnLinesPanel` + `useReturnLines`) sends packaging
   metadata; capture dialog has a unit selector.
3. DONE — review surfaces show entered qty + unit from the audit columns:
   - migration redefined `get_count_lines` to return `entered_qty`, `packaging_id`,
     `packaging_name`;
   - `useCountLines` exposes those fields plus `countLineEnteredLabel()`;
   - `CountReview` differences table renders "entered N × Case";
   - receiving (`useReceivingLines` + `ReceivingSessionWorkspace`) and returns
     (`returnsModel` / `useReturnLines` / `ReturnLinesPanel`) select `entered_qty`,
     `packaging_id` and a joined `product_packaging(name)` and render the same line.
   Verified: typecheck clean, 8/8 architecture guards passing.
4. PENDING — NEXT TASK: route every warehouse quantity render through the shared
   `formatQty` / packaging rollup so unit labels come from the Product foundation rather
   than ad-hoc strings, and extend the architecture guard to forbid hardcoded unit labels
   on warehouse surfaces.


## Phase 3 — Pending: Product foundation consumption audit
- Prove Warehouse reads product attributes (tracking mode, shelf-life, dimensions,
  hazmat, lifecycle status) from canonical product tables — no shadow columns on `wms_*`.
- Remove/park any duplicated product metadata found on warehouse tables.

## Phase 4 — Pending: Inventory ledger consumption audit
- Confirm every stock effect flows through sanctioned ledger functions
  (`stock_movements` / cost layers / quants) and that Warehouse never writes stock tables
  directly; add architecture guards pinning this.

## Phase 5 — Pending: Costing & valuation seam
- Landed cost, quarantine and damage dispositions must route to the canonical costing
  functions; no warehouse-local valuation.

---

## Instructions for the next agent

1. **Verify Phase 1 before writing new code.** Re-read the DB definitions of
   `wms_to_base_qty`, `wms_capture_receiving_line`, `wms_capture_return_line`,
   `record_count` and `wms_replay_guarded_call`; confirm the packaging params exist, that
   conversion happens server-side, and that both `entered_qty` and the base quantity are
   persisted. Run
   `bunx vitest run src/test/architecture/wms-server-authoritative-uom.test.ts` and a
   typecheck. Check the offline replay path end-to-end (enqueue → dispatcher → RPC).
2. Only once that verification passes, start **Phase 2 item 1** and work its items in
   order. Finish each item to a production-ready state (UI + server contract + guard test
   + this plan updated) before starting the next.
3. Do not jump phases, leave partial capture surfaces, or introduce workflows without
   their review/variance counterpart.
4. Update this file immediately after each completed item.
