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
| 7 | Availability repoint — server batch engine + UI | **VERIFIED (structural) — 7a–7e closed** |
| 8 | Documentation + behavioural sweep | **ACTIVE — ADR addendum done; behavioural proof BLOCKED (empty tenant DB)** |

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

## 3. Session 2026-08-14b — independent verification + Phase 7 closure

### Verification of the previous agent's claims (re-checked, not trusted)
- **7a — PASS.** `resolve_stock_availability_batch`: exactly one 6-arg overload,
  `SECURITY DEFINER`, `user_has_business_access` check, no `anon` EXECUTE. Body
  excludes blocked/quarantine/transit and subtracts only *open* `stock_reservations`.
- **7b — PASS.** `list_products_with_branch_stock`: one overload, sources
  on_hand/reserved/available from the batch engine, no local arithmetic.
- **7c — PASS.** `availability-is-server-owned.test.ts` green; `tsgo` clean.
- `resolve_stock_availability` confirmed a 421-char wrapper over the batch engine.

### Phase 7d — replenishment input — DONE (defect found and fixed)
The pending note assumed the browser was the only risk. It was wrong:
`run_replenishment_planning` (server) was itself a **second availability formula** —
`SUM(ws.quantity) - SUM(ws.reserved_quantity)` over `warehouse_stock`, which counted
transit / quarantine / blocked stock as available and read a projected counter instead
of open reservation rows. Rewritten (migration 2026-08-14) to:
- plan at (product, branch) grain, branches derived from `stock_quants` within the
  run's scope (rules with no stock still plan once, so stockouts stay visible);
- take on_hand / reserved / available from `resolve_stock_availability_batch` via a
  LATERAL call;
- scope expected supply and 28-day velocity to that same branch;
- stamp `explanation.availability_source`.
Grants re-asserted: `authenticated` + `service_role`; `anon` revoked.
`src/lib/replenishment/engine.ts` has **no production caller** (tests only), so it
remains a pure reference spec — no second recommender was created.

### Phase 7e — ratchet closure — DONE
`supabase/tests/inventory_availability_single_formula_test.sql` asserts: one batch
engine, `SECURITY DEFINER` + access check, no `anon` EXECUTE, single-product function
delegates, and no other `public` function derives `quantity - reserved`. SQL comments
are stripped before matching. Verified live: **zero offenders**. One shrink-only
allowlist entry: `_wms_maybe_enqueue_replen` (BIN grain, not yet exposed by the
engine — retire by adding a location grain to the batch engine).

---

## 4. Phase 8 — remaining work (ACTIVE)

- [x] ADR 0142 addendum — batch engine, planner repoint, BIN-grain exemption.
- [ ] ADR addenda for the Phase 5 expiry policy and the Phase 6 event fabric;
      refresh the operator guide.
- [ ] Run and read in full: `inventory_movement_ledger_test.sql`,
      `inventory_valuation_guard_test.sql`, `inventory_lot_serial_traceability_test.sql`,
      `inventory_event_fabric_test.sql`, `inventory_reservation_engine_test.sql`,
      `inventory_availability_single_formula_test.sql`, plus
      `check_movement_reversal_coverage()`, `check_stock_quant_drift(NULL)`,
      `check_valuation_writer_coverage()`, `check_inventory_valuation_drift(NULL,0.01)`,
      `check_serial_position_drift(NULL)`.
- [ ] **BLOCKED — behavioural proof.** The tenant database is still empty
      (0 `stock_movements`, 0 `stock_quants`). Receive stock through the UI, then
      confirm one movement → one quant row → one `inventory.movement.recorded`
      outbox row with `handler_scope='server'`, drained by `outbox-dispatcher`, and
      one cost layer at the expected AVCO. Every phase to date is *structurally*
      proven only; this is the wave's single largest outstanding risk.
- [ ] Follow-up carried out of Phase 7e: add a location grain to
      `resolve_stock_availability_batch` and delete the `_wms_maybe_enqueue_replen`
      allowlist entry.

## 5. Instructions for the next agent

1. Do not re-verify Phases 1–7; they were independently re-checked against the live
   database on 2026-08-14b (evidence in section 3). Re-run the two ratchets if in doubt:
   `bunx vitest run src/test/architecture/availability-is-server-owned.test.ts` and the
   SQL file `supabase/tests/inventory_availability_single_formula_test.sql`.
2. Execute Phase 8 in the order above. Do not open new phases until the behavioural
   sweep has real data behind it.
3. Never mark a phase VERIFIED on the strength of code existing.


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
