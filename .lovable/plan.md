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

## ✅ Phase D — Inbound shipments (ASN) schema (delivered 2026-07-16)

- **ADR:** `docs/adr/0069-inbound-shipments-asn.md`
- **Migration:** three tables + three enums with canonical inventory
  RLS shape (`user_can_access_business` + `can_access_branch` +
  `user_has_module_permission(..., 'inventory', 'write')` on writes;
  branch/business scope on reads):
  - `inbound_shipments` — ASN header (PO link, vendor, carrier, tracking,
    `expected_arrival_at`, lifecycle `draft → dispatched → in_transit →
    arrived → received → cancelled`).
  - `inbound_shipment_items` — vendor-declared expected qty / lot /
    expiry / manufacture date / packaging per product; optional back-ref
    to a specific `purchase_order_items` row.
  - `goods_receipt_discrepancies` — normalised over / short / damaged /
    wrong_item / expired / quality_hold ledger against a
    `goods_receipts` row; optional link to the ASN line that predicted
    the quantity; resolution enum
    (`pending / vendor_credit / insurance_claim / accept_and_move_on /
    return_to_vendor`).
- **Enums:** `inbound_shipment_status`,
  `goods_receipt_discrepancy_type`, `goods_receipt_discrepancy_resolution`.
- **updated_at** triggers on all three tables via
  `public._set_updated_at()`.
- **Architecture guard:** `src/test/architecture/inbound-shipments.test.ts`
  pins table creation, GRANT + RLS + policy shape, enum coverage, and
  FK linkage. 17/17 tests pass. Combined inventory guard surface: **35/35**.
- **No changes** to `purchase_orders`, `goods_receipts`, `stock_movements`,
  `warehouse_stock`, or any existing RPC. GRN authoring today keeps
  every capability; ASN + discrepancies are additive.

## ✅ Phase D.2 — GRN wizard ASN prefill (delivered 2026-07-16)

- **Wizard:** `src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx`
  now loads the newest active `inbound_shipment` for the PO
  (statuses `draft` / `dispatched` / `in_transit`, prefers dispatched/in_transit)
  and prefills every matching receipt line with
  `expected_quantity`, `expected_lot_number`, `expected_packaging_id`
  from `inbound_shipment_items`. Match is by `purchase_order_item_id`
  first, then falls back to `product_id`.
- **UX:** Receive step surfaces an ASN banner with shipment number +
  status so the user knows the prefill provenance.
- **Post-side reconciliation:** on successful `complete_goods_receipt_atomic`,
  the wizard now (a) transitions the shipment to `status='received'`
  with `received_at=now()`, and (b) inserts a
  `goods_receipt_discrepancies` row for every line where
  `received_quantity != expected_quantity` — typed `short` or `over`,
  resolution `pending`, linked to both `goods_receipt_item_id` and
  `inbound_shipment_item_id` for downstream vendor-credit / claim
  workflows. Failures on the reconciliation side log-and-continue so the
  GRN itself never rolls back on a discrepancy write.
- **Architecture guard:** `src/test/architecture/grn-asn-prefill.test.ts`
  pins the shipment query, the prefill fields, the `received` transition,
  and the discrepancy insert shape. 9/9 tests pass. Combined
  inventory-foundation guard surface: **44/44**.
- **Backward compatibility:** POs without an ASN receive the previous
  behaviour verbatim (fill remaining, no shipment or discrepancy writes).

## ✅ Phase D.3 — ASN CSV import (delivered 2026-07-16)

- **Field config:** `src/lib/importConfigs/asnImportConfig.ts` exports
  `ASN_IMPORT_FIELDS` — canonical `FieldDefinition[]` covering the ASN
  header (`shipment_number`, `po_number`, `vendor_name`, `carrier`,
  `tracking_number`, `dispatched_at`, `expected_arrival`) and the line
  detail (`product_sku`, `expected_quantity`, `expected_lot_number`,
  `expected_expiry_date`, `expected_manufacture_date`, `notes`).
- **Batch handler:** `src/lib/importConfigs/asnImportBatch.ts` exports
  `createAsnBatchImportHandler(ctx)` returning a `BatchImportFn`
  compatible with the existing `useImport` hook.
  - Groups rows by `shipment_number` (one CSV row = one line).
  - Idempotent: pre-checks existing `shipment_number` per business and
    skips duplicates as import errors, not RLS failures.
  - Resolves every SKU up-front via a caller-supplied `AsnProductResolver`;
    unknown SKUs skip the whole shipment cleanly (no partial inserts).
  - Optional `resolvePoByNumber` closure to backfill
    `purchase_orders.id` when the CSV carries a PO reference.
  - Header insert is followed by line insert; a line-insert failure
    rolls the header back so no orphan shipments remain.
  - Tenant scoping (`organization_id`, `business_id`, `branch_id`) is
    passed explicitly and stamped on every row, so RLS accepts writes
    without service-role escalation.
- **Barrel:** `src/lib/importConfigs/index.ts` now re-exports
  `ASN_IMPORT_FIELDS` + `createAsnBatchImportHandler`.
- **Architecture guard:** `src/test/architecture/asn-csv-import.test.ts`
  pins the field set, grouping contract, duplicate check, SKU
  resolution, tenant-scoped header insert, line insert shape, and
  header-rollback-on-line-failure. 11/11 tests pass. Combined
  inventory-foundation guard surface: **55/55**.
- **UI wiring:** deferred by design. Any page can bolt this into the
  existing `useImport` flow with `useImport(ASN_IMPORT_FIELDS)` +
  `startImport(createAsnBatchImportHandler({ ... }))`. Follows the same
  pattern as `PurchaseOrders.tsx` line ~199.

## ⏭ Next up

1. **Phase A.3 · UI plumbing** — lot/serial pickers on invoice /
   credit-note / sales-return / delivery-note / GRN line editors.
   Backend already enforces; this prevents users from hitting the guard
   mid-post. Reuse the existing POS `LotPickerPopover`; add a
   `SerialPickerPopover` reading `stock_serials WHERE status='in_stock'`.
2. **Phase D.3 UI wiring** — surface an "Import ASN" action on the
   Purchase Orders index (or a new `/inventory/inbound-shipments` list
   page). Compose `useImport(ASN_IMPORT_FIELDS)` with
   `createAsnBatchImportHandler`. Needs a `ProductResolver` that
   pulls SKUs scoped to the current business (mirror
   `ContactResolver` in `PurchaseOrders.tsx`).
3. **Phase E–H** — variants, import split, lot genealogy, GS1 parsing.
   Each stands alone with its own ADR.
4. **Ambient · Phase 5 drift gate** — retire `warehouse_stock` once
   `check_stock_quant_drift` returns empty 14 consecutive days.

## Ground truth for the next agent

- Transfer RPCs are the reference implementation for directional
  movement types + location stamping (ADR 0068). Copy this pattern for
  any future cross-location movement (manufacturing WIP, subcontract,
  RMA).
- The business transit location is a first-class ledger anchor —
  read via `get_business_transit_location(business_id)`, never via
  ad-hoc `stock_locations` queries.
- If you add another location-crossing RPC, populate both
  `source_location_id` and `destination_location_id` so the Phase-2
  quants shadow books proper double-entry. Setting only one is
  supported (single-side move) but should be intentional.
- ASN is the canonical pre-GRN signal (ADR 0069). Never author a
  discrepancy row directly against a `goods_receipts` line without
  linking it back to the receipt (`goods_receipt_id`) — that's the
  invariant every downstream vendor-credit / insurance-claim workflow
  will assume.
- The GRN wizard (`GoodsReceiptWizardPage.tsx`) is the reference
  implementation for ASN → GRN reconciliation (Phase D.2). When you
  add ANY new receiving surface, reuse the same three-step contract:
  (a) load active shipment by PO, (b) prefill from `expected_*`,
  (c) on post transition to `received` + insert
  `goods_receipt_discrepancies` for any qty delta.
- ASN imports go through `createAsnBatchImportHandler` (Phase D.3).
  Do not hand-write insert loops against `inbound_shipments` —
  the handler owns idempotency, SKU resolution, and header rollback.
- Inventory-foundation architecture guards live at
  `src/test/architecture/{outbound-lot-stamping,serial-tracking,split-transfer,inbound-shipments,grn-asn-prefill,asn-csv-import}.test.ts`.
  Do not weaken them; extend them when you add new contracts.
  Current surface: 55/55 tests, all green.

