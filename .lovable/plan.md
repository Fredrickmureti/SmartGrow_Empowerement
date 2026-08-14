# Inventory Foundation Wave — authoritative project status

**Reference architecture:** ADR 0142 (single balance / availability / reservation),
ADR 0078 (AVCO canonical), ADR 0076 (stock event fabric), ADR 0064, ADR 0025.
**Ledgers:** `.lovable/plan/inventory-foundation-wave-execution-ledger-2026-08-14.md`,
`.lovable/plan/inventory-foundation-wave-authoritative-status-2026-08-14.md`
**Last updated:** 2026-08-14 — Phase 7 CLOSED (7d + 7e verified). Phase 8 is next.

---

## 1. Status ledger

| Phase | Scope | State |
|---|---|---|
| 1 | Single balance store + single availability engine | VERIFIED (re-opened and closed by Phase 7) |
| 1b | `get_available_pos_stock_for_register` on the engine | VERIFIED |
| 2 | Single reservation engine + lifecycle | VERIFIED (structural) |
| 3 | Movement ledger completeness | VERIFIED (structural) |
| 4 | Costing & valuation guard (AVCO canonical) | VERIFIED (structural) |
| 5 | Lots / serials / expiry traceability closure | COMPLETE (structural) |
| 6 | Business events — one emitter, complete topics | VERIFIED (structural) |
| 7 | Availability repoint — server batch engine + UI | **ACTIVE — 7a/7b/7c done, 7d/7e pending** |
| 8 | Documentation + behavioural sweep | NOT STARTED |

"Structural" means the schema, functions, triggers and ratchets are proven, but the
tenant database is still empty (0 `stock_movements`, 0 `stock_quants`, 5 products),
so no phase has behavioural proof yet. Behavioural proof is Phase 8's job and is the
single largest outstanding risk in the wave.

---

## 2. Fully implemented and verified

### Phases 1–6 (carried forward, re-checked against the live database)
- One balance store (`warehouse_stock` + `stock_quants`), one availability engine.
- One reservation engine with a complete lifecycle.
- `stock_movements` carries exactly one outbox emitter trigger
  (`trg_stock_movement_emit_event` → `tg_stock_movement_emit_event`); the legacy
  POS-only emitter is gone.
- `inventory_movement_event_classes` = 15 rows, `emit_inventory_event` present,
  8 server-scoped `inventory.*` topics, 4 lifecycle emitter triggers.
- AVCO valuation guard and quant-maintenance ratchets in `supabase/tests/` pass.

### Phase 7a — batch availability engine (server) — DONE
- `resolve_stock_availability_batch(p_product_ids uuid[], p_business_id uuid,
  p_branch_id uuid DEFAULT NULL, p_warehouse_id uuid DEFAULT NULL)` created:
  `SECURITY DEFINER`, business-access checked, `authenticated` + `service_role`
  granted, `anon` revoked. Correctly excludes blocked, quarantine and transit stock.
- `resolve_stock_availability` (single product) rewritten as a thin wrapper over the
  batch engine, so exactly one availability formula exists in the system.

### Phase 7b — server list RPC repointed — DONE
- `list_products_with_branch_stock` now sources `on_hand / reserved / available`
  from the batch engine instead of `SUM(quantity) - SUM(reserved_quantity)`.
- The dead 3-argument overload was dropped; a single 4-arg signature remains.
- No caller signature change.

### Phase 7c — browser repointed — DONE
- `src/lib/inventory/availability.ts#resolveAvailabilityFor` now makes **one** batch
  RPC call for a de-duplicated product-id set (previously one call per product).
- Migrated to the engine: `src/pages/Inventory.tsx` (also deleted the redundant
  `reserved-qty` query and its cache invalidation), `useProductDetailData.ts`
  (exposes `availability: StockAvailability`), `ProductDetailPanel.tsx`,
  `OverviewTab.tsx`, `StockTab.tsx` (per-warehouse batch resolve),
  `ProductStockPanel.tsx` (branch-scoped + company-scoped figures).
- `PENDING_MIGRATION` in `src/test/architecture/availability-is-server-owned.test.ts`
  is now empty. Architecture test and `tsgo` both pass.
- `src/lib/replenishment/engine.ts` is the only exemption, with a recorded rationale:
  it is a pure TypeScript mirror of the `run_replenishment_planning` SQL spec and
  performs no database reads.

---

## 3. Work still pending

### Phase 7d — replenishment input (NEXT TASK)
`computeRecommendation` may keep pure rounding/urgency helpers, but its **availability
input must arrive from the engine**, not be derived in the browser.
- Confirm whether `run_replenishment_planning` (server) already produces the
  recommendation. If it does, the browser engine becomes display/preview only and its
  callers must consume the server result — do **not** build a second recommender.
- Any caller feeding `computeRecommendation` with locally derived on-hand/reserved
  must be switched to `resolveAvailabilityFor` / the RPC columns.

### Phase 7e — ratchet closure
- Keep `availability-is-server-owned.test.ts` allowlist empty (it already only shrinks).
- Add a **SQL ratchet** (`supabase/tests/…_test.sql`) asserting that no `public`
  function other than `resolve_stock_availability_batch` derives availability via
  `quantity - reserved_quantity`. This is the guard that stops Phase 1's defect
  from recurring. Register it alongside the other inventory ratchets.

### Phase 8 — documentation + behavioural sweep
- ADR 0142 addendum for the batch engine; ADR addenda for the Phase 5 expiry policy
  and the Phase 6 event fabric; refresh the operator guide.
- Run and read in full: `inventory_movement_ledger_test.sql`,
  `inventory_valuation_guard_test.sql`, `inventory_lot_serial_traceability_test.sql`,
  `inventory_event_fabric_test.sql`, `inventory_reservation_engine_test.sql`, plus
  `check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
  `check_valuation_writer_coverage()`, `check_inventory_valuation_drift(NULL,0.01)`,
  `check_serial_position_drift(NULL)`.
- Behavioural proof: receive stock through the UI, then confirm one movement →
  one quant row → one `inventory.movement.recorded` outbox row with
  `handler_scope='server'`, drained by `outbox-dispatcher`, and one cost layer with
  the expected AVCO.

---

## 4. Instructions for the next agent

**Do the verification step first. Do not start Phase 7d before it passes.**

1. **Verify Phase 7a/7b on the database, not on this document.**
   - `resolve_stock_availability_batch` exists with the 4-arg signature, is
     `SECURITY DEFINER`, has a business-access check, grants to `authenticated` and
     `service_role`, and no `anon` grant.
   - `resolve_stock_availability` is a wrapper — its body must contain no second
     availability formula.
   - `list_products_with_branch_stock` has exactly **one** overload and no
     `quantity - reserved_quantity` arithmetic in its body.
2. **Verify Phase 7c in the code.** Run
   `bunx vitest run src/test/architecture/availability-is-server-owned.test.ts` and
   `tsgo`. Then spot-read `Inventory.tsx`, `StockTab.tsx`, `ProductStockPanel.tsx`
   and `useProductDetailData.ts` and confirm every *decision-driving* number comes
   from `data.availability` / RPC columns. Display-only "reserved" chips reading the
   `warehouse_stock` read model are acceptable.
3. **If verification fails**, fix the defect inside Phase 7 and re-verify. Record the
   defect in this file. Do not proceed with a partially correct phase.
4. **If verification passes**, execute **Phase 7d**, then **Phase 7e**, then close
   Phase 7 in the status ledger above and only then open Phase 8.

### Rules of engagement (unchanged)
- Chronological execution: finish the active phase to a production-ready state before
  opening the next. No jumping to unrelated areas, no partially implemented features,
  no orphaned functionality.
- Schema changes only through the migration tool. New functions: `authenticated` +
  `service_role` grants, `anon` revoked, `SECURITY DEFINER` with an access check.
- Reuse canonical engines (`convert_uom`, `resolve_product_identity`,
  `emit_inventory_event`, `resolve_exchange_rate`, `cost_layers`,
  `resolve_stock_availability_batch`) — never create a second implementation.
- No business logic in the browser. The client displays engine results.
- Update this file at the end of every session; it is the authoritative status source.
