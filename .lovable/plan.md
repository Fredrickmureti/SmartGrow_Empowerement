# Inventory Foundation Wave — execution ledger

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0064 (locations & quants), ADR 0079 (Inventory vs Warehouse).
**Domain map:** `docs/audit/inventory-domain-map.md`
**Last updated:** 2026-08-14 (Phase 3 execution session)

---

## Part 1 — Status ledger

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | ✅ VERIFIED |
| 1b | `get_available_pos_stock_for_register` repointed onto the engine | ✅ VERIFIED |
| 2 | Single reservation engine + lifecycle | ✅ VERIFIED |
| 3 | Movement ledger completeness (4 items) | ✅ COMPLETE — see Part 2 |
| 4 | Costing & valuation guard (AVCO canonical, ADR 0078) | ▶ NEXT |
| 5 | Lots / serials / expiry traceability closure | NOT STARTED |
| 6 | Business events: one emitter, complete topics | NOT STARTED |
| 7 | UI repoint — clear the 8 allowlisted files | NOT STARTED |
| 8 | Documentation + operator guide refresh | NOT STARTED |

---

## Part 2 — Phase 3, implemented and verified this session

| Item | Delivered | Verification |
|---|---|---|
| 1. Reversal parity | `stock_movement_writers` registry (25 routines: 18 forward with a named reversal, 6 reversal routines, 1 self-test harness) + `check_movement_reversal_coverage()` reporting unregistered writers, stale registrations, and reversals that no longer exist | `check_movement_reversal_coverage()` returns 0 rows against the live database |
| 2. Value-only guard | `enforce_stock_movement_integrity` rejects `landed_cost` movements with non-zero quantity (`INVENTORY_VALUE_ONLY_MOVEMENT`) and quantity-bearing types with zero quantity (`INVENTORY_EMPTY_MOVEMENT`) | Trigger body inspected in `pg_proc`; ratchet asserts both error codes |
| 3. Provenance | `stock_movement_source_types` registry (27 kinds, 8 with a target table) + mandatory, registered, existence-checked `reference_type`/`reference_id` on every movement except `opening` / `migration` | All 25 writers audited: every inserted `reference_type` literal is registered and every named target table resolves |
| 4. Drift detection | `check_stock_quant_drift` is now four-way (`stock_quants` vs `warehouse_stock`, `warehouse_stock_lots` via `lot_id → stock_lots.lot_number`, and `products.stock_quantity`), returning `scope / warehouse_id / product_id / lot_number / quant_qty / projected_qty / drift`; surfaced at `/inventory-app/reports/integrity` | Function executes; page typechecks; nav entry added under Insights |

**Ratchet:** `supabase/tests/inventory_movement_ledger_test.sql` fails if the
registries disappear, the integrity trigger is dropped, any guard error code is
removed, a source type points at a missing table, reversal coverage regresses,
or the drift check stops covering all four stores.

**Frontend touched:** `src/hooks/inventory/useStockQuants.ts` (new
`StockQuantDriftRow` shape, new `useMovementReversalCoverage`, fixed a broken
`./useOrganization` import and corrected org-vs-business scoping in
`useLocationSummary`), `src/pages/inventory/InventoryIntegrity.tsx` (new),
`src/apps/inventory/routes.tsx`, `src/apps/inventory/nav.ts`.
`tsgo --noEmit` is clean.

---

## Part 3 — Instructions for the next agent

**First, verify — do not trust this ledger.** Before writing anything:

1. Run `check_movement_reversal_coverage()` and `check_stock_quant_drift(NULL)`
   against the live database; both must return zero rows.
2. Confirm `trg_enforce_stock_movement_integrity` exists on `stock_movements`
   and that its body still raises all five documented error codes.
3. Confirm every `stock_movement_source_types.target_table` resolves, and that
   no function inserting into `stock_movements` is missing from
   `stock_movement_writers`.
4. Confirm the ratchet file `supabase/tests/inventory_movement_ledger_test.sql`
   is present and its assertions still match the shipped objects.
5. Load `/inventory-app/reports/integrity` and confirm both cards render.

Only after those checks pass, **resume at Phase 4 — costing and valuation
guard**. Phase 4 adds no new valuation engine. It enforces ADR 0078:

- AVCO on `products.cost_price` / `warehouse_stock.average_cost` is the only
  valuation authority; `cost_layers` is lot-level detail and must never be read
  as a valuation source.
- Add a guard/test that fails when a function outside the AVCO writer set
  updates a valuation field, and a ratchet under `supabase/tests/`.
- Add a valuation-drift check (AVCO value vs `cost_layers` roll-up) and surface
  it on the existing Inventory integrity report rather than building a new page.

Do not jump to Phases 5–8 before Phase 4 is coherent and ratcheted. Phase 7 (UI
repoint) stays blocked until the server-side guards for Phases 4–6 are in place.


============================
Phase 4 (costing & valuation guard) is implemented and verified in the database; only the plan-file update remains.

Verified first (Phase 3 re-check): reversal coverage 0 rows, quant drift 0 rows, integrity trigger present, 27 source types / 25 registered writers.

Phase 4 delivered:

inventory_valuation_writers registry (5 routines, flagged as AVCO and/or layer writers) — AVCO on products.cost_price / warehouse_stock.average_cost remains the sole valuation authority.
check_valuation_writer_coverage() static scan flags unregistered costing logic or stale registrations — returns 0 rows live.
enforce_valuation_write_authority() with triggers on warehouse_stock and cost_layers: API roles (anon/authenticated) can never move average_cost or touch cost layers; layer provenance (product_id, business_id, source_movement_id, qty_total, received_at) is immutable; negative valuation and out-of-range qty_remaining rejected. All four error codes confirmed in the deployed body, both triggers installed.
check_inventory_valuation_drift(business, tolerance) comparing warehouse AVCO and product AVCO against the remaining cost-layer roll-up — 0 rows live.
Frontend: useValuationDrift / useValuationWriterCoverage hooks plus two new cards ("Valuation agreement", "Costing write authority") on /inventory-app/reports/integrity. tsgo --noEmit clean.
Ratchet: supabase/tests/inventory_valuation_guard_test.sql.
Remaining (not done): updating .lovable/plan.md to mark Phase 4 complete/verified and set Phase 5 (lots/serials/expiry traceability closure) as next, with the standard "verify Phase 4 before continuing" handoff — re-run the three checks above (check_valuation_writer_coverage(), check_inventory_valuation_drift(NULL,0.01), both triggers present) before resuming.


===========