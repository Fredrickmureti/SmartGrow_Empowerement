# ADR 0026 — Delivery Note ↔ Product coupling, snapshotting, and goods-issue accounting

- Status: Accepted
- Date: 2026-06-01
- Supersedes/refines: 0011 (Delivery Note as logistics document), 0002 (AVCO on receipt), 0016 (inventory adjustment GL integrity), 0025 (lot-aware quants & FEFO)

## Context

A previous incident: invoice creation failed because a Delivery Note (DN) was
missing fields that had been introduced in the Product/Inventory area. The root
cause was that DN generation and rendering read directly from the live
`products` table, so any Product schema change (new required field, rename,
delete) could break Sales/Delivery workflows.

This ADR records the durable contract that decouples DN behaviour from Product
schema evolution, and the accounting rules that govern goods-issue.

## Decision

### 1. Delivery Note is a logistics/inventory document sourced from Sales

A DN is created by one of:

- **SO → DN** — fulfilment of a confirmed Sales Order (`sales_order_id` set).
- **Invoice → DN (auto)** — `confirm_invoice_atomic` auto-creates a `pending`
  DN for stockable lines of a direct invoice (`source_invoice_id` set).
- **Return DN** — `create_return_delivery_atomic` creates an `is_return = true`
  DN linked to the original via `return_of_dn_id`.

Inventory only moves at **goods-issue** (DN completion via
`complete_delivery_atomic`), never at invoice confirmation.

### 2. Product master is snapshotted on `delivery_note_items`

The line carries point-in-time copies so historical DNs are immutable against
later Product edits:

- `product_name_snapshot` — frozen at insert by trigger `_dni_fill_product_snapshots`.
- `product_sku_snapshot` — frozen at insert.
- `uom_snapshot` — base UoM code frozen at insert.
- `cost_at_shipment` — the unit cost used for the COGS journal entry, persisted
  by `complete_delivery_atomic` at goods-issue and **never recomputed**.
- `description`, `unit_price`, `tax_rate`, `tax_amount`, `discount_percent`,
  `line_total` — already snapshotted at insert.

**UI/PDF/print templates MUST read the snapshot columns**, falling back to the
live product join only for pre-migration rows where the snapshot is null.

### 3. Narrow, documented dependency on `products.*`

DN-creating/completing RPCs depend on exactly these Product columns:

| Column | Used by | Purpose |
|---|---|---|
| `name` | snapshot trigger | freeze `product_name_snapshot` |
| `sku` | snapshot trigger | freeze `product_sku_snapshot` |
| `base_uom_id` → `units_of_measure.code` | snapshot trigger | freeze `uom_snapshot` |
| `track_inventory` | `confirm_invoice_atomic`, `complete_delivery_atomic` | decide if a line moves stock |
| `type` (`= 'product'`) | `confirm_invoice_atomic` | decide stockable lines for auto-DN |
| `cost_price` | `complete_delivery_atomic` | source of `cost_at_shipment` when not pre-set |
| `is_lot_tracked` | `complete_delivery_atomic` | route to FEFO/lot consumption |

**Adding** Product columns (batch/serial/regulatory/pharma/manufacturing
fields, etc.) is always safe — DN logic ignores unknown columns. **Renaming or
removing** any column in the table above is a breaking change and must update
the RPCs in the same migration. Any future Product schema change consults this
ADR first.

### 4. Single COGS locus — goods-issue only

COGS posts **exclusively** in `complete_delivery_atomic` (`source_type =
'delivery_note'`, `source_subtype = 'cogs'`). `confirm_invoice_atomic` posts
only Revenue/AR/Tax (`source_type = 'invoice'`) and takes **no** COGS argument
(the legacy `p_cogs_lines` parameter was removed). This prevents double-COGS,
matches Odoo/ERPNext/Sage/Infor, and aligns COGS recognition with physical
goods movement.

### 5. First-class return delivery with symmetric GL

`create_return_delivery_atomic` produces an `is_return` DN linked by
`return_of_dn_id`. On completion it posts the **inverse** of the original
goods-issue: `return_in` stock movements and a symmetric GL entry (DR Inventory
/ CR COGS, `source_subtype = 'cogs_reversal'`) valued at the original line's
`cost_at_shipment`, and restores SO reservations/fulfilment.

### 6. Two-mode fulfilment policy (SMB ↔ enterprise)

`confirm_invoice_and_release_stock_atomic(p_invoice_id, p_user_id,
p_main_lines, p_release_stock, p_warehouse_id)` is the single authoritative
overload. It always calls `confirm_invoice_atomic` (which auto-creates a
`pending` DN), then branches on `p_release_stock`:

- `true` (small-business convenience) — immediately completes the DN, so
  inventory movements and COGS happen in one step at invoice confirmation.
- `false` (enterprise warehouse flow) — leaves the DN `pending` for a warehouse
  user to confirm later, so inventory moves at the actual goods-issue moment.

`p_warehouse_id` is accepted for API stability; `complete_delivery_atomic`
resolves the branch's active warehouse itself.

## Consequences

- Product schema can evolve additively without touching Sales/Delivery.
- Historical DNs render and value identically forever.
- Inventory and GL stay synchronised across deliveries, cancellations, and
  returns; reservation accounting is symmetric.
- The same engine serves both a one-click SMB flow and a controlled enterprise
  pick/confirm flow.

## Enforcement

`supabase/tests/delivery_notes_invariants_test.sql` (pgTAP) asserts the
snapshot trigger, the single corrected release overload (no `p_cogs_lines`
reference), reservation-restore and return functions, both over-delivery caps,
and symmetric return GL.

## Amendment 2026 — lifecycle ownership moved into the database

Convergence audit findings and the resulting contract:

1. **Lifecycle columns are engine-owned.** Table-wide `UPDATE`/`DELETE` on
   `delivery_notes` is revoked from `authenticated`/`anon`; only descriptive
   columns (`notes`, `delivery_date`, `shipping_address`, `driver_name`,
   `vehicle_number`, `contact_id`, `received_by_contact_id`,
   `auto_invoice_on_complete`, `updated_at`) are granted back. `status`,
   `delivered_at`, `dispatched_at`, `ready_at`, `cancelled_at` and
   `spawned_invoice_id` can therefore only change inside the SECURITY DEFINER
   engines (`mark_delivery_ready_atomic`, `dispatch_delivery_atomic`,
   `complete_delivery_atomic`, `record_partial_delivery_atomic`,
   `cancel_delivery_atomic`, `create_invoice_from_delivery_atomic`,
   `wms_manifest_bridge_delivery_notes`). A browser can no longer mark a note
   delivered without stock movement, `cost_at_shipment` and the COGS journal.
2. **Deletion is cancellation.** Client delete is revoked; removal routes
   through `cancel_delivery_atomic` so movements and journals reverse.
3. **Numbering is atomic and business-scoped.** `get_next_delivery_number`
   takes an advisory lock per business and parses only the sequence segment;
   a unique index enforces one number per business. Legacy duplicates of
   `DN-2026-2026` were renumbered.
4. **Creation is atomic.** `create_delivery_note_atomic(p_payload, p_lines,
   p_user_id)` allocates the number and writes header + lines in one
   transaction; the client no longer reserves numbers.
5. **Two contacts FKs must be disambiguated.** Every embed uses
   `contact:contacts!contact_id(...)` and
   `received_by_contact:contacts!received_by_contact_id(...)`; a bare
   `contacts(...)` embed is ambiguous and fails at runtime.

Ratchet: `src/__tests__/architecture.delivery-note-engine.test.ts`.
