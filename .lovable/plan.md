# Inventory Foundation Wave — audit verdict and reconstruction plan

Status document for this wave. Update after every phase.

## What I verified this session (not taken on trust)

Checked against the live database and the code, not against previous logs.

- The ledger substrate is real and mature: `stock_movements` (immutability,
  provenance, branch-scope triggers), `stock_quants` (location + lot + package
  grain, with `reserved_quantity`), `stock_lots`, `warehouse_stock_lots`,
  `stock_serials`, `cost_layers`, `business_event_outbox` with
  `tg_stock_movement_emit_event`, drift checks, and `reverse_stock_movement`
  already exist. ADRs 0064–0079 landed for real.
- **Two competing balance stores.** `stock_quants` (location-grain, ADR 0064)
  and `warehouse_stock` (warehouse-grain) are both maintained by triggers, and
  every consumer — availability functions, reservations, reports, all UI —
  reads `warehouse_stock`. Nothing reads quants for availability. Two stores,
  one silently unused for the decisions that matter.
- **Three availability formulas.** `get_available_stock`,
  `get_available_pos_stock`, `get_available_pos_stock_for_register` each derive
  availability differently (POS subtracts register-scoped reservation rows;
  the general one subtracts a denormalised counter). None accounts for
  quarantine/blocked/damaged state. This is exactly the drift the mandate
  forbids.
- **Four reservation engines.** `reserve_stock` (bumps a counter, writes no
  reservation row), `create_stock_reservation` (counter + row),
  `reserve_pos_stock`, and `_wms_replen_reserve`. `reserve_stock` and
  `create_stock_reservation` are near-identical copies whose effects diverge —
  one leaves reserved quantity with no audit row behind it.
- **Availability is computed in the browser in ~10 surfaces**
  (`Inventory.tsx`, `Forecast.tsx`, `ProductStockPanel`, `StockTab`,
  `OverviewTab`, `WarehouseStockPeekSheet`, `LicensePlateView`, `readOnHand`),
  each doing `quantity - reserved_quantity` locally. Business rule in React.
- Costing ambiguity is already resolved on paper (ADR 0078: AVCO canonical,
  `cost_layers` demoted to lot detail) but no guard enforces it, and
  value-only revaluation has functions (`inventory_apply_cost_revaluation`)
  whose relationship to the movement ledger is undocumented.
- **The database is empty** (0 movements, 0 quants, 0 warehouse_stock rows, 0
  reservations). There is no production data to protect, so consolidation is
  preferred over compatibility shims.

Verdict: **not a re-foundation, a consolidation wave.** The engine exists; it
has three heads. The work is to collapse quantity, availability and reservation
onto one canonical server-side owner and force every consumer through it.

## Phase 0 — Engineering report (for the next engineer, not the user)

Write `docs/audit/inventory-domain-report.md` covering the mandated
deliverables in condensed form: domain definition and ownership boundary,
Product↔Inventory boundary, lifecycle, movement taxonomy, quantity model, UOM
integration, availability and reservation models, costing/valuation, lot and
serial, expiry/recall, integrations (Warehouse, Purchasing, Sales, POS, Landed
Cost, Finance, Labels, Reporting), event taxonomy, idempotency and concurrency
model, tenant/branch scope matrix, governance, RLS, audit reconstruction,
defects, duplicates, missing capabilities, dependency graph, canonical
source-of-truth matrix, risk. Plus an ADR for the decisions below.

## Phase 1 — One quantity truth

`stock_quants` becomes the sole maintained balance store (location + lot +
package grain). `warehouse_stock` is rebuilt as a derived read model
(view or trigger-fed projection with a drift check), never written directly.
Retire the second maintenance trigger; keep the existing drift log as the
consistency mechanism. Quantity states (on hand, reserved, blocked,
quarantined, damaged, in transit, incoming) become explicit and derivable from
quant location usage rather than inferred per-consumer.

## Phase 2 — One availability engine

New canonical `resolve_stock_availability(...)` reading quants + live
reservation rows, honouring location usage (transit/quarantine excluded),
branch and business scope, with an explicit documented formula. Delete or
reduce `get_available_stock`, `get_available_pos_stock`,
`get_available_pos_stock_for_register` to thin wrappers over it. Single client
seam under `src/lib/inventory/`. Architecture test banning any new client-side
`quantity - reserved` arithmetic and any direct `warehouse_stock` read for an
availability decision.

## Phase 3 — One reservation engine

Consolidate onto `reserve_stock_atomic` / `release_stock_reservation` /
`consume_stock_reservation` with a real lifecycle (requested → reserved →
allocated → consumed | released | expired), a mandatory reservation row for
every held quantity, idempotency keys, expiry sweep, partial reservation and
concurrency-safe row locking at quant grain. `reserve_stock` and
`create_stock_reservation` are deleted; POS, Sales, WMS replenishment and
transfers repoint. Reserved quantity is derived from reservation rows, never
an independently mutated counter.

## Phase 4 — Movement ledger completeness

Prove and close: reversal parity for every reference type through
`reverse_stock_movement`; value-only revaluation expressed as a first-class
valuation event (not a zero-quantity movement hack), tied to
`inventory_apply_cost_revaluation` and landed cost; reclassification and
quarantine transitions as typed movements; an AVCO guard test enforcing
ADR 0078 (no `cost_layers` cost read outside lot valuation).

## Phase 5 — Event taxonomy

Audit `tg_stock_movement_emit_event` coverage against the business-event list
(received, issued, transferred, adjusted, reserved, released, revalued, lot
created/expired). Add missing publishes inside the same transaction as the
state change via the existing outbox — no new event infrastructure. Migrate one
downstream consumer off direct trigger coupling as proof.

## Phase 6 — Downstream contract audit

For POS, Sales, Purchasing/GRN, Warehouse, Landed Cost, Finance, Labels and
Reporting: record what each reads, writes, emits and consumes; repoint any
module that computes stock, availability, reservation or valuation itself; add
architecture guards so bypass cannot return.

## Phase 7 — Inventory UI on the canonical read model

One inventory read model serving dashboard, product stock tab, warehouse peek,
forecast and pickers: on hand, available, reserved, incoming, blocked, value,
lots, expiry, recent movements, exceptions — all server-resolved. No fabricated
metrics; anything the engine cannot answer is not displayed.

## Phase 8 — Verification sweep (must actually run, output read in full)

pgTAP suites for availability, reservation lifecycle, concurrency (parallel
reserve against the same quant), idempotency (duplicate receipt/sale/transfer),
reversal, tenant and branch isolation; `bunx vitest run src/test/architecture`;
typecheck; and a browser pass covering receive → reserve → sell → return with
reconstruction of both quantity and value from the ledger.

## Rules of engagement

Migrations only through the migration tool; new functions granted to
`authenticated` + `service_role`, `anon` revoked. Reuse only —
`convert_uom`, `resolve_product_identity`, `publish_business_event`,
`resolve_exchange_rate`, `post_journal_entry_atomic`, the governance engine,
the document engine. No fallback engines, fail closed. No business logic in the
browser. Phases run in dependency order; none is left partially landed.
