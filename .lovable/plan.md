# Sales → Inventory Allocation & Lot Traceability — Forensic findings + correction plan

All statements below are marked CONFIRMED (database/code evidence gathered this turn),
SUSPECTED (consistent with evidence, not yet proven), or NOT VERIFIED.

## 1. Executive finding

**The inventory is correct. Sales is asking the wrong warehouse — because the invoice line never tells the lot picker which warehouse it is.** (CONFIRMED)

- Stock exists, is lot-aware, and reconciles perfectly: 1,200 base units of
  `SIM Fresh Milk 500ml` sit in Headquarters Warehouse under lot `LOT-20260819`
  (exp 2026-11-19) in aggregate, per-lot, and quant ledgers. (CONFIRMED)
- The FEFO engine `resolve_fefo_lots` would return that lot for 24 units.
  It is never called from the invoice screen, because the lot picker receives
  `warehouseId = null`. The "No lots available in this warehouse" text is the
  picker's *empty* state, printed while the query is disabled — it is not a
  FEFO answer. (CONFIRMED)
- The `1,176 remaining` figure is `1,200 − 24` from the aggregate stock cell —
  a different, correct source. There is **no** aggregate-vs-lot divergence.
  (CONFIRMED)
- Separately, `stock_lots` has a `goods_receipt_id` column but **no foreign key**
  to `goods_receipts`, so the Lot detail page's PostgREST embed
  `goods_receipt:goods_receipts(...)` 400s. That is the "Failed to load lot"
  error, unrelated to allocation. (CONFIRMED)
- The `confirm_invoice_and_release_stock_atomic` 400 reason is **NOT VERIFIED** —
  the real SQL exception was never captured. GL mappings, warehouse resolution
  and the server-side FEFO fallback all look satisfiable, so the failure must be
  reproduced and read before anything is changed there.

## 2. Evidence

Product: `58e15e40…c99dc` · SIM-MILK-500 · `track_inventory/is_lot_tracked/is_expiry_tracked = true` · `stock_quantity = 1200`.
Warehouse HQ: `22782c20…ab988` (WH-HQ, active, default, not in-transit, branch = Headquarters).
Branch Headquarters: `default_warehouse_id = NULL`.

| Source | Qty | Warehouse | Lot-aware | Reserved | Available |
|---|---|---|---|---|---|
| `products.stock_quantity` | 1200 | company-wide | no | — | 1200 |
| `warehouse_stock` | 1200 | WH-HQ | no | 0 | 1200 |
| `warehouse_stock_lots` | 1200 | WH-HQ, lot LOT-20260819 | yes | 0 | 1200 |
| `stock_quants` | 1200 | WH-HQ / "Stock" (internal, unblocked) | yes (lot_number) | 0 | 1200 |
| `stock_movements` | +1200 `adjustment`, lot stamped, ref `stock_adjustment` | WH-HQ | yes | — | — |
| `resolve_fefo_lots` | would allocate 24 from that lot | WH-HQ | yes | 0 | 1200 |

Invariant `aggregate available == Σ lot available` holds (1200 == 1200). (CONFIRMED)

Lot chain is intact end-to-end: adjustment → movement → `stock_lots` →
`warehouse_stock_lots` → `stock_quants`. Adjustment warehouse and invoice
warehouse **MATCH: YES** (both WH-HQ).

UoM path is correct and server-authoritative: the draft invoice line stores
`quantity = 24` (base), `display_quantity = 2`, `packaging_id` set. No React
arithmetic feeds the ledger; one canonical conversion engine. (CONFIRMED)

Broken wiring (CONFIRMED):
`src/components/invoices/InvoiceLineRow.tsx` renders `<OutboundLineTracking>`
with only `productId` + `quantity`. `OutboundLineTracking` then resolves
`warehouseId = currentBranch.default_warehouse_id` → `NULL`, so
`useFefoSuggestion` is disabled (`ready = false`), `data` stays undefined, and
`LotPickerPopover` renders "No lots available in this warehouse". The invoice's
own `SalesWarehouseField` selection (`invoices.warehouse_id = WH-HQ`) is never
passed down.

## 3. Root-cause classification

- [x] Sales API/props contract defect — invoice line does not pass its warehouse/business context to the lot picker.
- [x] Product-model/schema defect — `stock_lots.goods_receipt_id` has no FK, breaking the lot traceability read.
- [x] Observability defect — the invoice error toast replaces the server message with "An unexpected error occurred".
- [ ] Inventory reconciliation defect — **not supported** (ledgers reconcile).
- [ ] FEFO allocation defect — **not supported** (function is correct; it was never called).
- [ ] UoM defect — **not supported**.
- [ ] Lot creation / propagation / warehouse mismatch — **not supported**.
- [ ] Invoice RPC defect — **undetermined**, pending the captured error.

## 4. Correction plan

**Step 0 — capture the real invoice error before any RPC change (no code change).**
Reproduce invoice create+confirm against the live app and read the actual
Postgres exception from the 400 body. Only after that do we decide whether
`confirm_invoice_and_release_stock_atomic` / `complete_delivery_atomic` need a
fix. Note for that step: the wrapper accepts `p_warehouse_id` but never forwards
it (SUSPECTED benign — the delivery note carries the warehouse — must be
confirmed against the captured error).

**Step 1 — pass real context to the lot/serial pickers.**
- File: `src/components/invoices/InvoiceLineRow.tsx` (plus the same omission in
  the other outbound line editors if present: credit note, sales return).
- Current: `<OutboundLineTracking productId quantity />`.
- Required: also pass `businessId` and `warehouseId` from the document header
  (`invoice.warehouse_id` / `useSalesWarehouse()`), threaded through the line-row
  props. Reuse the existing `OutboundLineTracking` override props — no new hook,
  no new query. Branch default stays as the fallback only.
- Migration: NO.

**Step 2 — distinguish "not asked" from "nothing available" in the picker.**
- File: `src/components/inventory/LotPickerPopover.tsx`.
- When `warehouseId`/`businessId` is missing, render "Select a warehouse first"
  instead of "No lots available in this warehouse". Presentation only.
- Migration: NO.

**Step 3 — restore the lot traceability read.**
- Object: `public.stock_lots.goods_receipt_id`.
- Add the missing `FOREIGN KEY … REFERENCES goods_receipts(id) ON DELETE SET NULL`
  so the existing PostgREST embed resolves (verify no orphan values first; clean
  them in the same migration if any exist).
- Migration: YES.

**Step 4 — stop swallowing server errors on invoice create/confirm.**
- File: the invoice create/confirm mutation's error handling (`confirmInvoiceGL`
  already forwards the message; the page-level toast replaces it).
- Required: surface the server business message, keeping the friendly prefix.
- Migration: NO.

**Step 5 — guards.**
- Extend `src/test/architecture/sales-inventory-integrity.test.ts` (or
  `outbound-lot-serial-ui.test.ts`) to pin that every outbound line editor passes
  an explicit `warehouseId` to `OutboundLineTracking`.
- Add a SQL ratchet asserting the `stock_lots → goods_receipts` FK exists.

Nothing in this plan weakens lot validation, expiry enforcement, FEFO,
reservations, atomicity, valuation or GL posting, and it introduces no second
UoM or allocation engine.
