# ADR 0067 — Serialised Inventory

**Status:** Accepted (2026-07-16)
**Depends on:** ADR 0064 (locations & quants), ADR 0066 (downstream lot/serial stamping)

## Context

Lot tracking (ADR 0066) covers batches — many units share one `lot_number`.
High-value or regulated goods (electronics, appliances, medical devices,
firearms) require **per-unit** traceability. Each physical unit needs its own
identity, lifecycle, and location, and every stock movement must reference
exactly one serial.

## Decision

### 1. Product flag
`products.is_serial_tracked boolean not null default false`. Independent of
`is_lot_tracked`; a product can be both (serial belongs to a parent lot).

### 2. Serial ledger — `stock_serials`
One row per physical unit, scoped by `business_id`. Unique on
`(business_id, product_id, serial_number)`. Columns:

| Column | Purpose |
|---|---|
| `status` | `in_stock` / `reserved` / `shipped` / `returned` / `scrapped` |
| `current_location_id`, `current_warehouse_id` | Where the unit lives right now |
| `lot_number` | Optional parent lot |
| `last_movement_id` | Back-reference to the movement that produced current state |
| `received_at`, `shipped_at` | Lifecycle timestamps |

RLS: `user_can_access_business` + branch + `inventory:write` for mutation,
same read scope for select. Service role: full.

### 3. Movement-level enforcement
Trigger `enforce_serial_on_movement` on `stock_movements`:

- Rejects any insert for a serial-tracked product without `serial_number`.
- Upserts the matching `stock_serials` row, deriving `status` and location
  from `movement_type` (`purchase_in`/`transfer_in`/`adjustment_in` →
  `in_stock`; `sale_out`/`delivery_out` → `shipped`; `transfer_out` →
  `reserved`; `scrap`/`adjustment_out` → `scrapped`; `return_in` →
  `returned`).
- Sets `current_location_id` from `destination_location_id` (fallback:
  `source_location_id`).

### 4. Downstream posting guard
`enforce_downstream_lot_stamping` (from ADR 0066) is extended: invoices,
credit notes, and sales returns cannot transition into a posted status if
any line for a serial-tracked product is missing `serial_number`. Same
contract as lot enforcement — only the column checked changes.

## Consequences

- On-hand for serial-tracked products can be computed either from
  `stock_serials WHERE status = 'in_stock'` or from `v_stock_on_hand`; both
  must agree. A future drift RPC mirrors `check_stock_quant_drift`.
- UI (line editors, GRN, POS) must present a `SerialPickerPopover` for
  serial-tracked products. That is presentation work; scope of this ADR is
  schema + ledger + enforcement only.
- No breaking change for lot-only or untracked products. Default is off.

## Alternatives rejected

- **Overloading `lot_number` as serial** — breaks FEFO semantics and hides
  per-unit lifecycle behind an aggregate column.
- **Storing serials on movements only** — no way to answer "where is unit
  SN-42 right now?" without scanning the full ledger.

## Non-goals for this ADR

- Serial-level FEFO / picking UI.
- Warranty tracking (belongs on a future `product_warranties` table keyed
  by `stock_serials.id`).
- RMA workflow beyond the existing sales-return path.