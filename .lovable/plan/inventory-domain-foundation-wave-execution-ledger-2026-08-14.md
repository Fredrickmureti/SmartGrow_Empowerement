# Inventory Domain — Foundation Wave (execution ledger)

Scope: the Inventory application only (`/inventory-app/*`, its hooks, RPCs and
tables). External domains are crossed only far enough to record a contract.

## Verified evidence (this session, checked against live DB + code)

- Substrate is real and mature: `stock_movements` (immutability, provenance and
  branch-scope triggers), `stock_quants` (product+location+lot+package grain,
  with `reserved_quantity`), `stock_lots`, `warehouse_stock_lots`,
  `stock_serials`, `cost_layers`, `business_event_outbox` +
  `tg_stock_movement_emit_event`, drift checks, `reverse_stock_movement`.
  ADRs 0064–0079 genuinely landed.
- **Two balance stores.** `stock_quants` (location grain) and `warehouse_stock`
  (warehouse grain) are both trigger-maintained; every consumer —
  availability functions, reservations, reports, all UI — reads
  `warehouse_stock`. Quants are effectively unused for decisions.
- **Three availability formulas.** `get_available_stock`,
  `get_available_pos_stock`, `get_available_pos_stock_for_register` derive
  availability differently, none accounts for quarantine/blocked/transit state
  beyond an `is_in_transit` warehouse flag.
- **Four reservation paths.** `reserve_stock` (bumps a counter, writes no
  reservation row), `create_stock_reservation` (counter + row),
  `reserve_pos_stock`, `_wms_replen_reserve`. The first two are near-identical
  copies whose effects diverge — reserved quantity can exist with no audit row.
- **Availability arithmetic in the browser** in ~10 surfaces (`Inventory.tsx`,
  `Forecast.tsx`, `ProductStockPanel`, `StockTab`, `OverviewTab`,
  `WarehouseStockPeekSheet`, `LicensePlateView`, `readOnHand`), each doing
  `quantity - reserved_quantity` locally.
- Cost method resolved on paper (ADR 0078: AVCO canonical, `cost_layers`
  demoted to lot detail) but no guard enforces it; value-only revaluation
  (`inventory_apply_cost_revaluation`) has no documented tie to the ledger.
- Database is **empty** (0 movements / quants / warehouse_stock / reservations),
  so consolidation is preferred over compatibility shims.

Verdict: **consolidation wave, not re-foundation.** The engine exists with three
heads. Collapse quantity, availability and reservation onto one server-side
owner and force every consumer through it.

---

## Phase 0 — Architecture map — NOT STARTED

Short implementation-oriented map in `docs/audit/inventory-domain-map.md`:
Inventory-owned entities, ownership matrix (capability / correct owner /
current owner / canonical source / consumers), lifecycle per business process
(receive, sell, transfer, return, adjust), canonical engines to reuse, known
defects, downstream contracts, missing foundations. One ADR recording the
decisions in Phases 1–3. No long report.

## Phase 1 — Core inventory integrity — NOT STARTED

Dependencies: Phase 0.

1. **One quantity truth.** `stock_quants` becomes the sole maintained balance
   store; `warehouse_stock` is rebuilt as a derived projection (never written
   directly), keeping the existing drift log as the consistency mechanism.
   Quantity states (on hand, reserved, blocked, quarantined, in transit,
   incoming) become explicit and derivable from location usage.
2. **One availability engine.** `resolve_stock_availability(...)` over quants +
   live reservation rows, branch/business scoped, documented formula; the three
   existing functions become thin wrappers or are dropped. Single client seam
   in `src/lib/inventory/`.
3. **One reservation engine.** `reserve_stock_atomic` /
   `release_stock_reservation` / `consume_stock_reservation` with a real
   lifecycle (requested → reserved → allocated → consumed | released |
   expired), a mandatory row per held quantity, idempotency keys, expiry sweep,
   partial reservation, quant-grain row locking. `reserve_stock` and
   `create_stock_reservation` deleted; POS, Sales, WMS replenishment and
   transfers repointed (contract change only, no consumer rebuild).
4. Guards: architecture test banning client-side `quantity - reserved` math and
   direct `warehouse_stock` reads for availability decisions; pgTAP for
   concurrency (parallel reserve on one quant) and idempotency.

## Phase 2 — Valuation — NOT STARTED

Reversal parity for every reference type through `reverse_stock_movement`;
value-only revaluation expressed as a first-class valuation event rather than a
zero-quantity movement, tied to `inventory_apply_cost_revaluation` and landed
cost; AVCO guard test enforcing ADR 0078; adjustment/return/transfer/write-off
valuation paths proven deterministic and reversible. No second valuation engine.

## Phase 3 — Lots, serials, traceability — NOT STARTED

Prove the supplier → receipt → lot → warehouse → transfer → sale → customer
chain is reconstructible end to end from canonical records; close any gap in
lot/serial stamping or genealogy views. No recall feature work.

## Phase 4 — Counts and adjustments — NOT STARTED

Separate observation (count) from consequence (adjustment): count → variance →
approval through the existing governance engine → adjustment → valuation
consequence → audit event. No inventory-specific approval engine.

## Phase 5 — Transfers and replenishment — NOT STARTED

Transfers as stateful business processes with in-transit inventory, partial /
cancelled / failed paths and reversal; Inventory keeps stock authority while
Warehouse keeps physical execution. Replenishment audited only for the state
Inventory owns and exposes.

## Phase 6 — Reporting — NOT STARTED

Stock on hand, availability, valuation, aging, movements, lot traceability and
turnover become projections over canonical Inventory state. No reporting tables
created for UI convenience.

## Phase 7 — Inventory UI — NOT STARTED

Repoint dashboard, Stock, product stock surfaces, forecast and pickers onto the
canonical read model: on hand, available, reserved, incoming, blocked, value,
lots, expiry, recent movements, exceptions — all server-resolved. Rebuild only
surfaces that misrepresent domain state. No fabricated metrics.

## Phase 8 — Integration verification — NOT STARTED

For Product, Purchasing/receiving (GRN, ASN), Warehouse, Sales, POS, Labels,
Landed Cost and Finance record: Inventory provides / consumer expects /
mismatch / required Inventory-side correction / external wave. Contract
verification only.

## Verification sweep (runs with each phase, output read in full)

pgTAP suites for availability, reservation lifecycle, concurrency, idempotency,
reversal, tenant and branch isolation; `bunx vitest run src/test/architecture`;
typecheck; browser pass covering receive → reserve → sell → return with both
quantity and value reconstructed from the ledger.

## Rules of engagement

Migrations only through the migration tool; new functions granted to
`authenticated` + `service_role`, `anon` revoked. Reuse only — `convert_uom`,
`resolve_product_identity`, `publish_business_event`, `resolve_exchange_rate`,
`post_journal_entry_atomic`, the governance engine, the document engine. Fail
closed, no fallback engines, no business logic in the browser. Phases run in
dependency order; a phase is VERIFIED only with evidence, passing tests and
correct ownership.
