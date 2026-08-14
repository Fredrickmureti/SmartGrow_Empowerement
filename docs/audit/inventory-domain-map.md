# Inventory domain map (Foundation Wave, 2026-08-14)

Execution map, not a report. Companion to `.lovable/plan.md`.

## 1. Ownership matrix

| Capability | Correct owner | Current owner | Canonical source | Consumers |
|---|---|---|---|---|
| Product identity, UoM, packaging, physical attrs | Product | Product | `products`, `product_packaging`, `product_physical_attributes`, `resolve_product_measure` | Inventory, Labels, Purchasing, Sales |
| Stock quantity (balance) | Inventory | **split** — `stock_quants` + `warehouse_stock` + `products.stock_quantity` | `stock_quants` (target) | everything |
| Movement ledger | Inventory | Inventory | `stock_movements` (immutable, provenance + branch triggers) | Finance, WMS, reports |
| Availability | Inventory | **split** — 3 SQL functions + ~10 browser derivations | `resolve_stock_availability` (new) | Sales, POS, WMS, Purchasing |
| Reservations | Inventory | **split** — 4 RPC paths | `stock_reservations` + one RPC family (target) | Sales, POS, WMS |
| Cost / valuation | Inventory (facts) / Finance (posting) | Inventory | AVCO on `products.cost_price` + `warehouse_stock.average_cost` (ADR 0078); `cost_layers` = lot detail only | Finance, Landed Cost, reports |
| Lots / serials / genealogy | Inventory | Inventory | `stock_lots`, `warehouse_stock_lots`, `stock_serials`, `v_lot_downstream_consumption` | Recall, Sales, POS |
| Locations (bins/zones) | Warehouse (authoring) / Inventory (schema) | shared | `stock_locations` | Inventory, WMS |
| Physical execution (LPN, tasks, waves) | Warehouse | Warehouse | `wms_*` | — |
| Receiving intent (PO, ASN, GRN) | Purchasing | Purchasing | `purchase_orders`, `inbound_shipments`, `goods_receipts` | Inventory consumes the receipt outcome |
| Accounting posting | Finance | Finance | `post_journal_entry_atomic` | — |
| Approvals | Governance | Governance | approval registry / requests | Inventory registers actions |
| Business events | Platform | Platform | `business_event_outbox`, `publish_business_event`, `tg_stock_movement_emit_event` | all |

## 2. Lifecycle (as implemented, after Phase 1)

```text
Business command (receive / sell / transfer / adjust / return)
  → atomic RPC validates + writes stock_movements (immutable)
  → trg_maintain_stock_quants        : quants = the balance
  → trg_project_warehouse_stock      : warehouse_stock = derived projection
  → trg_maintain_warehouse_stock_lots: per-lot balance
  → trg_maintain_cost_layers         : lot cost detail (not valuation)
  → trg_update_wac_on_receipt        : AVCO cost (canonical valuation)
  → trg_stock_movement_emit_event    : business_event_outbox
  → Finance / WMS / reporting consume
```

## 3. Quantity model

Single maintained balance: `stock_quants(product, location, lot, package, owner, lpn)`.
Derived projections, never written directly:

- `warehouse_stock.quantity` / `.reserved_quantity` — warehouse rollup (also
  carries reorder config and per-warehouse `average_cost`, which stay writable).
- `products.stock_quantity` — company-wide cache.
- `warehouse_stock_lots` — per-lot balance.

State comes from the location the quant sits in
(`stock_locations.location_type` / `usage` / `is_blocked`), not from extra
columns: internal+unblocked = on hand and sellable, `transit` = in transit,
`quarantine`/`is_blocked` = held, `scrap` = written off.

## 4. Availability

Canonical: `resolve_stock_availability(product, business, branch, warehouse)`
→ `on_hand, reserved, blocked, in_transit, available`.

```text
available = Σ quants at internal, unblocked, non-transit locations
          − Σ open reservations (reserved/allocated, not expired)
```

Every other reader is a wrapper. Browser must never subtract reserved itself.

## 5. Reservations

`stock_reservations` is the only hold record. Lifecycle:
`reserved → allocated → consumed | released | expired`. Idempotency key per
source command; expiry sweep releases stale holds. Reserved quantity is always
derived from reservation rows — no free-floating counter.

## 6. Boundaries crossed (contracts only)

- **Purchasing → Inventory**: GRN confirmation is the authoritative receipt
  event; Inventory writes movements from it. Purchasing never touches balances.
- **Warehouse → Inventory**: WMS moves stock between locations; Inventory owns
  the quant effect. `wms_lpn` movements are audit rows (plate ops relocate
  quants directly) — documented exception in `_maintain_stock_quants`.
- **Sales / POS → Inventory**: must call availability + reservation RPCs.
- **Landed Cost / Finance → Inventory**: consume valuation facts; posting stays
  in `post_journal_entry_atomic`.
- **Labels → Product + Inventory**: identity/packaging from Product, lot/expiry
  from Inventory.

## 7. Known defects at wave start

1. Two balance stores, consumers read the unused-for-decisions one.
2. Three availability formulas; ~10 browser-side derivations.
3. Four reservation paths, two of them near-duplicates with divergent effects.
4. `_maintain_stock_quants` silently returned when a warehouse had no default
   location — quantity vanished from the quant ledger (fail-open).
5. No guard enforcing ADR 0078 (AVCO canonical, `cost_layers` = detail).
