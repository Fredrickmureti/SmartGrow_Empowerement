# ADR 0083 — WMS Cross-dock & Cartonization

**Status:** Accepted (2026-07-17) · **Related:** 0079 (Inventory/WMS split), 0080 (Yard), 0081 (Labour), Phase 2 (Receiving), Phase 4 (Pack).

## Context

Two capabilities were missing from the WMS after Phase 11:

1. **Cross-dock.** Every inbound receipt (GRN) flowed into put-away
   regardless of whether an already-open sales order needed the same
   SKU. In high-throughput 3PL/DC operations this is the single largest
   avoidable touch — the "receive → putaway → replenish → pick" chain
   is replaced with a direct "receive → stage → ship".
2. **Cartonization.** `wms_pack_cartons` recorded carton dimensions per
   pack event as free-form numbers. There was no reusable carton
   catalogue and no engine to pick a fit from product cube/weight, so
   pack stations either used one default box (over-ship cost) or asked
   the operator to guess (labour cost + damage risk).

## Decision

### Cross-dock

- New `wms_crossdock_opportunities` table (RPC-only writes). One row
  per `(business_id, grn_line_id)`; the unique constraint makes the
  evaluator idempotent under GRN re-completion or trigger retries.
- Evaluation happens automatically via an `AFTER UPDATE OF status`
  trigger on `goods_receipts` (`trg_wms_crossdock_on_grn_complete`)
  which calls `evaluate_crossdock_on_grn(grn_id)`. The evaluator:
  - Skips receipt lines with an open QC hold (Phase 7.1 owns those).
  - Skips lines already in the opportunities ledger.
  - Matches oldest unfulfilled sales order line for the same product,
    same business, FIFO by `sales_orders.order_date`.
- Two operator-facing RPCs: `confirm_crossdock_stage` and
  `cancel_crossdock_opportunity`. Both emit
  `warehouse.crossdock.<status>` events onto `business_event_outbox`
  with idempotency key `wms.crossdock_opportunity:<id>:<status>` —
  same shape as ADRs 0076, 0079, 0080, 0081.
- Trigger uses `EXCEPTION WHEN OTHERS THEN RAISE WARNING` so a failed
  evaluation never fails the GRN transition (same tradeoff as ADR 0076).

### Cartonization

- New `wms_carton_types` master data table, business-scoped. CRUD via
  PostgREST, gated by the `inventory:write` permission.
- New `suggest_carton(business_id, product_ids[], quantities[])`
  RPC returns the smallest active carton whose interior volume and
  max weight cover the sum of product `length_cm*width_cm*height_cm`
  and `weight_kg`. Returns NULL when product dimensions are missing
  so the pack UI can prompt manual selection instead of guessing.
- New `wms_pack_cartons.carton_type_id` column stamped only via the
  `assign_carton_to_pack(carton_id, carton_type_id)` RPC. The RPC
  copies the carton type's L/W/H onto the pack row and adds the tare
  weight, so downstream shipping labels stay consistent.

## Consequences

- Zero surgery to Inventory. No new cost/valuation logic — cross-dock
  still hits `stock_movements` through the existing Receiving (Phase 2)
  and Dispatch (Phase 5) paths; the ledger only tags which receipt
  lines took the short path.
- `business_event_outbox` gains three new event types
  (`warehouse.crossdock.matched`, `.staged`, `.cancelled`) that future
  billing/analytics can consume.
- Pack costing gains a real anchor: carton `cost` on the catalogue
  plus tare_weight let 3PL billing (ADR 0082) charge carton usage as
  a first-class activity in later phases.

## Non-goals

- 3-D bin-packing / multi-carton splits. `suggest_carton` returns one
  carton for the whole line item bundle; multi-carton packing is
  operator-directed at Pack station and will land in Phase 13 when
  bin-packing heuristics ship.
- Cross-dock across warehouses (moving GRN receipt at WH-A to satisfy
  a sales order at WH-B). Requires an inter-warehouse transfer leg
  and is out of scope until Phase 14.
- Auto-assignment of `carton_type_id` at pack time. The RPC exists;
  wiring `PackStation` to call `suggest_carton` before submit is a
  Phase 12.1 follow-up.
