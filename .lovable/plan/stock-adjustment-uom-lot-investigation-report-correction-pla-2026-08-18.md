# Stock Adjustment — UoM & Lot Investigation Report + Correction Plan

## A. Executive finding

**Confirmed.** The server already owns a complete, correct UoM conversion and
lot-tracking model for stock adjustments. The create RPC
`apply_or_request_stock_adjustment` **drops** every unit-of-measure and
lot/serial field before writing the line, so that model is unreachable from
any client. The 400/`23514` is the server correctly refusing an incomplete
business event.

- **Confirmed:** `stock_adjustment_items` has `packaging_id`, `display_uom_id`,
  `display_quantity`, `lot_number`, `serial_number`, `lot_allocations`.
  The RPC's `INSERT ... VALUES` names only `product_id, warehouse_id,
  branch_id, quantity_before, quantity_adjustment, quantity_after, unit_cost,
  notes`. The other eight columns are never written by any function
  (`approve_stock_adjustment_atomic` is the only other function that mentions
  `lot_number` on this table, and it only *reads* it).
- **Confirmed:** the conversion engine exists and is server-side —
  BEFORE trigger `trg_uom_normalize_adj_items` → `_uom_normalize_adj_line()`,
  which converts `packaging_id × display_quantity` (and
  `display_uom_id` via `convert_uom`) into base `quantity_adjustment` and
  recomputes `quantity_after`, preserving sign. It is dead code today because
  the RPC always supplies base-only input.
- **Confirmed:** "pieces" is **not hardcoded**. `AdjustmentNew.tsx` renders
  `productBaseLabelOrUnset(selProd)`; for product
  `58e15e40-…c99dc` the base UoM genuinely *is* `PCE / Piece`. This is
  category **D** (legitimate canonical base UoM exposed by the UI), with the
  real defect being the **absence of a pack selector**, not a wrong label.
- **Confirmed:** the lot rejection is correct server behaviour, not a bug to
  weaken.
- **Not supported by evidence:** a Product-model regression. The product row is
  coherent (`base/sales/purchase_uom_id` all = Piece, `track_inventory=true`,
  `is_lot_tracked=true`, `is_expiry_tracked=true`) and a valid
  `product_packaging` row exists ("Case of 12", `qty_in_base_uom = 12`,
  shipping unit). Nothing is stale or orphaned. The gap is in the adjustment
  write seam only.

## B. Current architecture (as it actually is)

```text
products (base_uom_id -> units_of_measure; is_lot_tracked / is_expiry_tracked)
   |
product_packaging (name, qty_in_base_uom)          <- alternate units, per product
   |
AdjustmentNew.tsx  (qty in base units only, no pack/lot/expiry fields)
   |
useInventory.createStockAdjustment  (CreateStockAdjustmentInput: no uom/lot fields)
   |
rpc apply_or_request_stock_adjustment  <-- DROPS packaging/display/lot/serial
   |
stock_adjustment_items
   |  trg_uom_normalize_adj_items -> _uom_normalize_adj_line()   [never has input]
   |  enforce_line_uom_consistency, immutability, branch cascade
   |
approve_stock_adjustment_atomic
   |  qty>0 + lot-tracked  -> REQUIRES lot_number      <-- the 23514
   |  qty<0 + lot-tracked  -> lot_allocations or resolve_fefo_lots + consume_lots_atomic
   |  resolves cost, offset account, posts journal entry
   |
stock_movements (22 triggers: _maintain_warehouse_stock_lots, _maintain_stock_quants,
                 update_product_stock, enforce_lot_expiry_policy, cost layers, WAC)
```

Canonical answers:
- Inventory is stored in **base units** of `products.base_uom_id`, in
  `warehouse_stock`, `stock_quants`, `warehouse_stock_lots`,
  `products.stock_quantity`.
- Alternate units are **per product** rows in `product_packaging`
  (`qty_in_base_uom`); global `units_of_measure` conversion goes through
  `convert_uom` within one category.
- Conversion is owned by the DB trigger layer. There must not be a second one.

## C. Actual failure path

1. Operator picks the milk product, types a positive quantity, submits.
2. Payload per line: `{product_id, warehouse_id, quantity_adjustment,
   unit_cost, notes}` — no unit, no lot, no expiry.
3. RPC inserts the line (unit fields null), auto-approves, calls
   `approve_stock_adjustment_atomic`.
4. Product is `is_lot_tracked = true` and `quantity_adjustment > 0`, so the
   function raises `check_violation` (`23514`): *"positive adjustment requires
   lot_number on the line"*. Whole transaction rolls back — correct.
5. A positive adjustment for this product would *also* hit
   `enforce_lot_expiry_policy` on the movement (product is expiry-tracked)
   unless the lot carries an expiry date, depending on the resolved policy.

The product has **zero** rows in `warehouse_stock_lots`, so a positive
adjustment must **create** the lot — it cannot pick an existing one.

## D–G. Remaining findings

- **UoM:** engine already authoritative; adjustment does not use it; "pieces"
  is real data, not a hardcode.
- **Lot:** configuration is intentional (perishable milk). The RPC is right;
  the UI never collects a lot number and the API contract has no field for it.
- **Client/server boundary:** `AdjustmentNew.tsx` does **no** inventory
  arithmetic (only a cost prefill and cost/warehouse form validation). No
  violation today — and none must be introduced.
- **Classification:** [x] API contract defect (RPC drops columns) ·
  [x] UI defect (no unit / lot / expiry capture) · [ ] product-model
  regression · [ ] UoM architecture defect · [ ] weaken-the-constraint fix.

## Correction plan

### Must NOT change
- `approve_stock_adjustment_atomic` lot/serial invariants and the FEFO
  consumption path.
- `_uom_normalize_adj_line`, `convert_uom`, `enforce_lot_expiry_policy`,
  immutability triggers, GL posting.
- No conversion arithmetic in React. No second conversion engine.

### 1. Migration — widen the write seam (no invariant weakened)
Recreate `apply_or_request_stock_adjustment` so each item may carry
`packaging_id`, `display_uom_id`, `display_quantity`, `lot_number`,
`serial_number`, `expiry_date`, `lot_allocations`, and insert them.
- When `display_quantity`/`packaging_id` are supplied, `quantity_adjustment`
  is left to the existing trigger to derive — the client sends intent, the
  server converts.
- Validate server-side that `packaging_id` belongs to the product and that
  `display_uom_id` shares the base UoM category; reject otherwise
  (Scenario G/H).
- Pre-flight the lot requirement in the create RPC too, so the operator gets
  the error before an adjustment row is created.
- If `expiry_date` is supplied with a new lot number, upsert `stock_lots`
  for that lot within the same transaction, before the movement is written.

### 2. Hook contract
Extend `CreateStockAdjustmentInput.items` with the optional fields above and
forward them verbatim. No arithmetic added to the hook.

### 3. UI — `AdjustmentNew.tsx`
Per line, driven by the product's real configuration:
- Unit selector: base UoM plus the product's `product_packaging` rows
  (reuse `PackagingSelect`). Hidden when the product has no packs
  (Scenario F). Quantity input is labelled with the chosen unit and shows a
  read-only "= N <base>" preview for operator confidence only — the value
  sent is `display_quantity` + `packaging_id`, never a computed base number.
- When the product is lot-tracked and the quantity is **positive**: required
  Lot number field, plus Expiry date when the product is expiry-tracked.
- When lot-tracked and **negative**: no lot number required — leave it to
  FEFO; optionally allow picking lots later via the existing
  `LotPickerPopover` (out of scope for this wave).
- Serial-tracked products: block with a clear message pointing at the serial
  workflow (this wave does not build serial capture).

### 4. Tests
- SQL: `supabase/tests/stock_adjustment_uom_lot_test.sql` — carton input of 2
  on a 12-per-case product yields base 24; invalid packaging rejected;
  positive lot-tracked without lot still raises; negative lot-tracked still
  FEFO-resolves.
- Vitest architecture ratchet: the adjustment payload builder contains no
  multiplication of quantity by a pack factor, and the RPC insert column list
  includes the provenance and lot columns.

### 5. Compatibility
All new item fields are optional; existing callers (WMS counts, opening
stock, deep links) keep working unchanged and continue to send base units.
