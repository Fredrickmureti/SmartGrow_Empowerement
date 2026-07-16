# ADR 0069 — Inbound Shipments (ASN) and Goods-Receipt Discrepancies

**Status:** Accepted (2026-07-16)
**Depends on:** ADR 0066 (downstream lot/serial stamping), ADR 0068 (split transfers)
**Related:** ADR 0024 (per-base-unit cost scaling on GRN)

## Context

The audit flagged Goods Receipt as ⚠: today a GRN is authored from a
`purchase_order` directly, with no upstream carrier-driven signal. That
prevents the warehouse from:

- Knowing what to expect before the truck arrives.
- Recording per-lot / per-expiry data the vendor already knows.
- Distinguishing "over-received" from "short-received" from "damaged
  in transit" from "wrong item" — every enterprise WMS separates these
  because each has different downstream postings (vendor debit note,
  insurance claim, quality hold, replenishment escalation).

Enterprise systems solve this with an **Advance Shipping Notice** (ASN /
EDI-856) sitting between PO and GRN, plus a normalised **discrepancy
ledger** on the receipt.

## Decision

Two new tables. No changes to existing PO / GRN shapes.

### 1. `inbound_shipments`
The ASN header. One row per physical shipment. Links back to zero or
more `purchase_orders` (an ASN can consolidate multiple POs, but the
common case is 1:1).

Key columns:

| Column | Purpose |
|---|---|
| `purchase_order_id` | Optional FK (multi-PO consolidation defers to line-level FK). |
| `vendor_id` | Denormalised for supplier-side queries. |
| `carrier`, `tracking_number` | Free-text; carriers are not modelled as first-class today. |
| `expected_arrival_at` | Warehouse planning signal. |
| `status` | `draft` → `dispatched` → `in_transit` → `arrived` → `received` → `cancelled`. |
| `received_at`, `warehouse_id`, `branch_id` | Populated when the linked GRN closes the shipment. |
| `notes` | Free-text. |

### 2. `inbound_shipment_items`
The ASN detail. One row per (shipment, product, expected lot) combination.

| Column | Purpose |
|---|---|
| `purchase_order_item_id` | Optional FK — allows one shipment line to reconcile back to a specific PO line. |
| `expected_quantity` | Base-unit quantity the vendor claims is on the truck. |
| `expected_lot_number`, `expected_expiry_date`, `expected_manufacture_date` | Vendor-declared lot metadata; the GRN can trust or override. |
| `expected_packaging_id` | Pack unit the vendor shipped in. |
| `notes` | Free-text (damage warning, temperature excursion, etc.). |

### 3. `goods_receipt_discrepancies`
A normalised discrepancy ledger. One row per (goods_receipt, product,
discrepancy_type). Not an alternative to the GRN quantities — a
sibling that captures *why* the GRN quantity differs from the expected
quantity.

| Column | Purpose |
|---|---|
| `goods_receipt_id` | FK to the receipt that recorded the discrepancy. |
| `inbound_shipment_item_id` | Optional FK — links back to the ASN line, when one exists. |
| `product_id` | Product involved. |
| `discrepancy_type` | `over`, `short`, `damaged`, `wrong_item`, `expired`, `quality_hold`. |
| `expected_quantity`, `received_quantity` | Both stored so downstream reports don't need to re-derive. |
| `resolution` | `pending`, `vendor_credit`, `insurance_claim`, `accept_and_move_on`, `return_to_vendor`. |
| `notes` | Free-text. |

## Integration

- **GRN wizard (out of scope this migration):** when a PO has one or more
  `dispatched` / `in_transit` ASNs, the wizard prefills lines from
  the ASN's `expected_*` fields. The user still confirms or overrides
  before posting. On post, the ASN transitions to `received` and any
  quantity/lot mismatches automatically land a
  `goods_receipt_discrepancies` row (default `resolution = 'pending'`).
- **CSV import (out of scope this migration):** an EDI-856 stand-in
  CSV can populate `inbound_shipments` + `inbound_shipment_items`
  ahead of any real EDI partnership. Column names mirror table names
  1:1 to keep the mapping trivial.
- **Recall:** `v_lot_downstream_consumption` continues to work; ASN
  lines that never became GRN lines are correctly excluded because
  they have not produced stock movements.

## Backward compatibility

- Existing GRN flow is untouched. A GRN authored without an ASN keeps
  every capability it has today; the ASN link is optional at the header
  level and the discrepancy ledger is optional at the line level.
- Existing analytic views (v_stock_on_hand, control_account_tieout,
  etc.) do not reference these tables.

## Enforcement

- `src/test/architecture/inbound-shipments.test.ts` pins the migration
  SQL: tables exist, GRANTs are present, RLS is enabled, and every
  policy scopes through `user_can_access_business` +
  `can_access_branch` + `user_has_module_permission(...,'inventory',...)`.

## Out of scope

- Multi-PO consolidation at the header level (deferred until a real
  customer needs it; `purchase_order_item_id` at the line level is
  sufficient interim).
- ASN acknowledgements to the vendor (EDI-855).
- Carrier tracking APIs.
- Automated posting of vendor debit notes from discrepancy rows
  (ADR-0031-family controls posting; a future ADR will define the
  discrepancy-to-vendor-credit-note path).
