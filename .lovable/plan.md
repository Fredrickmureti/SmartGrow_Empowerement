## Phase 0 — Verification of prior work (done)

Cross-checked `.lovable/plan.md` claims against the codebase:

| Claim | Verified |
|---|---|
| ADRs 0064–0067 present | ✅ |
| 7 migrations `20260716210212` → `215647` present | ✅ |
| Downstream lot/serial columns + recall view + posting-guard | ✅ |
| Serialised inventory schema (`stock_serials`) + movement guard | ✅ |
| Architecture guards `outbound-lot-stamping.test.ts` + `serial-tracking.test.ts` | ✅ 8/8 tests pass |
| `useStockQuants` hook present | ✅ |
| `warehouse_stock` still authoritative; Phase 5 gated on 14 clean drift-check days | ✅ correct posture |

**Verdict:** Phases 1–4 (locations/quants/transit/quarantine), Phase A.1–A.2 (downstream lot stamping + RPC propagation), and Phase B (serials) are genuinely delivered and contract-tested. No superficial patches detected. The only remaining ⚠ from the audit that is a *small, high-leverage* refactor is Phase C — split-transfer adoption.

## What I execute next — Phase C · split-transfer adoption

**Why now:** transit location + `v_stock_on_hand` transit filter already exist (Phase 4). This is the last piece that makes in-transit stock a real ledger state instead of a naming convention, and it unblocks Phase D (ASN) cleanly.

### Steps

1. **Read existing transfer surface** — `src/hooks/useWarehouses.ts` (transfer list/create paths) and the latest `create_stock_transfer` / `complete_stock_transfer` RPC definitions across the 4 migrations that touch them. Understand current single-movement `transfer` emission before changing anything.

2. **ADR 0068 — Split stock transfers** (one page): defines the two-movement contract (`transfer_out` source→transit, `transfer_in` transit→destination), the atomic vs in-transit modes, and how `v_warehouse_stock_effective` continues to net out.

3. **Migration** (`supabase/migrations/2026071622*_split_stock_transfer.sql`):
   - Rewrite `complete_stock_transfer` (or introduce `complete_stock_transfer_v2` + wrapper) to emit both movements in one transaction via `get_business_transit_location(business_id)`. Instant transfers fire both; in-transit transfers fire `transfer_out` on submit and `transfer_in` on receipt.
   - Backfill: none required — historic single-movement transfers stay as-is; the view already tolerates them.
   - GRANT + RLS unchanged (RPC is `SECURITY DEFINER`, callers already gated).

4. **Architecture guard** `src/test/architecture/split-transfer.test.ts` — pins the migration SQL to the two-movement contract (SQL string inspection, same pattern as the existing guards).

5. **Verify:** run the new guard + the two existing inventory guards; confirm `v_warehouse_stock_effective` still excludes transit rows.

6. **Update `.lovable/plan.md`** with a Phase C completion entry and hand off Next 2 (A.3 UI pickers) and Next 3 (Phase D ASN) to the next agent.

### Explicitly out of scope this turn

- Phase A.3 UI plumbing (lot/serial pickers on invoice/CN/return forms).
- Phase D ASN / inbound shipments.
- Phase E–H (variants, import split, lot genealogy, GS1).
- Retiring `warehouse_stock` — still drift-gated.

## Technical notes

- No changes to `warehouse_stock` triggers or to `src/integrations/supabase/types.ts` (regenerated post-migration).
- `movement_type` is `text`; `transfer_out`/`transfer_in` add without an enum migration.
- RPC stays idempotent via existing transfer status guards; no new idempotency key needed.
- Follows CREATE → GRANT → RLS → POLICY order for any new object; migration is RPC-only so no new tables expected.

## ✅ Phase C — Split stock transfers (delivered 2026-07-16)

- **ADR:** `docs/adr/0068-split-stock-transfers.md`
- **Migration:** helper `get_business_transit_location(uuid)` +
  full rewrite of `approve_stock_transfer_atomic` and
  `complete_stock_transfer_atomic`.
- **Directional tokens:** every emitted `stock_movements` row from a
  transfer RPC now carries `movement_type = 'transfer_out'` (negative
  legs) or `'transfer_in'` (positive legs). The legacy generic
  `'transfer'` token is no longer emitted — historical rows stay valid
  and the `_maintain_warehouse_stock_lots` + on-hand rebuild views
  already tolerate both.
- **Location provenance:** each movement stamps `source_location_id` /
  `destination_location_id`:
  - Source-warehouse dispatch: source = source WH default location.
  - Into transit: destination = **business virtual transit location**
    (Phase 4 / ADR 0065), not the in-transit warehouse's default.
  - Out of transit: source = business virtual transit location.
  - Destination receipt: destination = dest WH default location.
- **`stock_quants` shadow** now accumulates in-transit inventory on the
  canonical business transit location. The physical in-transit warehouse
  remains the `warehouse_id` anchor only because `stock_movements.warehouse_id`
  is still NOT NULL (removable in Phase 5).
- **Architecture guard:** `src/test/architecture/split-transfer.test.ts`
  pins directional tokens, location stamping, and helper usage on both
  RPCs. 10/10 tests pass. Combined inventory guard surface: 18/18 green.
- **No `warehouse_stock` schema change.** Phase 5 drift gate unchanged.

## ⏭ Next up

Same priority order as before:

1. **Phase A.3 · UI plumbing** — lot/serial pickers on invoice /
   credit-note / sales-return / delivery-note / GRN line editors.
   Backend already enforces; this prevents users from hitting the guard
   mid-post. Reuse the existing POS `LotPickerPopover`; add a
   `SerialPickerPopover` reading `stock_serials WHERE status='in_stock'`.
2. **Phase D · ASN / inbound shipments** — ADR 0069, `inbound_shipments`
   + `inbound_shipment_items`, `goods_receipt_discrepancies`, GRN wizard
   prefill from ASN, CSV EDI-856 stand-in.
3. **Phase E–H** — variants, import split, lot genealogy, GS1 parsing.
   Each stands alone with its own ADR.
4. **Ambient · Phase 5 drift gate** — retire `warehouse_stock` once
   `check_stock_quant_drift` returns empty 14 consecutive days.

## Ground truth for the next agent

- Transfer RPCs are now the reference implementation for directional
  movement types + location stamping. Copy this pattern for any future
  cross-location movement (manufacturing WIP, subcontract, RMA).
- The business transit location is now a first-class ledger anchor —
  read via `get_business_transit_location(business_id)`, never via
  ad-hoc `stock_locations` queries.
- If you add another location-crossing RPC, populate both
  `source_location_id` and `destination_location_id` so the Phase-2
  quants shadow books proper double-entry. Setting only one is
  supported (single-side move) but should be intentional.
