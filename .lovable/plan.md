## Situation

The previous engineer left `.lovable/plan.md` as the roadmap. **Phase 1 (Procurement)** and **Phase 2 (Warehouse Ownership & Domain Boundary)** are marked CLOSED. Spot checks confirm the Phase 2 claims match reality: `src/pages/inventory/Warehouse*.tsx` no longer exists, `/inventory-app/warehouses[/*]` is now `<Navigate replace>` into `/warehouse-app/warehouses[...]`, `src/test/architecture/wms-phase-master-data.test.ts` is in place, ADR 0080 documents the decision, and the warehouse nav + cycle-count contract are wired as described.

The **parent prompt's questions are therefore already answered by Phase 2** — Warehouse master data is owned by the Warehouse app; Inventory is a read-only consumer; cycle counts split scan-first execution (WMS) from adjustment posting (Inventory) via `warehouse.count.session.completed`. The continuation prompt asks the next engineer to verify Phases 1 & 2, then start **Phase 3 — Inventory Domain Audit & Reconstruction**.

This plan covers both.

---

## Plan

### Step 0 — Full verification of Phases 1 & 2 (no code)

Run the verification battery from `.lovable/plan.md` verbatim:

- SQL: 13 canonical procurement RPCs present, `SECURITY DEFINER`, `search_path=public`; `apply_vendor_credit_atomic` gone; 7 Batch-N triggers present; zero `supplier_id` columns on transactional docs; `governance_duties` has both `credit.*` duties.
- Code: `rg` for `apply_vendor_credit_atomic`, `pages/inventory/Warehouse`; both empty in `src/`.
- Tests: `bunx vitest run src/test/architecture` — everything green, especially `wms-phase-master-data.test.ts` and `no-direct-stock-aggregate-writes.test.ts`.
- Types: `tsgo -p tsconfig.app.json` clean.
- Runtime: `/inventory-app/warehouses` and `/inventory-app/warehouses/<uuid>` redirect correctly; Inventory sidebar has no Warehouses entry; both cycle-count surfaces link to each other.
- Supabase linter — no regressions.

Any failure gets fixed under its owning phase before Phase 3 opens. Findings written up in `docs/audit/phase-1-2-verification.md`.

### Step 1 — Phase 3 discovery pass (still no code)

Written deliverable only, produced as `docs/audit/inventory-ownership-map.md`:

1. **Ownership map.** Enumerate every table Inventory should own (`stock_quants`, `stock_movements`, `stock_locations`, `cost_layers`, `cost_layer_consumptions`, `stock_lots`, `stock_serials`, `stock_reservations`, `stock_transfers`, `stock_transfer_items`, `stock_adjustments`, `stock_adjustment_items`, `physical_counts`, `physical_count_lines`, `warehouse_stock`, `warehouse_stock_lots`, `lot_quarantine`) and prove no other app writes to them today (`rg` for direct `.from('stock_...').insert|update|delete|upsert` outside `src/apps/inventory/**` and outside sanctioned RPC wrappers).
2. **Write-path inventory.** For every current writer, list: caller → hook → RPC. Flag every path that is not `SECURITY DEFINER` + `search_path` + SoD-guarded + `FOR UPDATE`-locking its aggregate.
3. **Cross-domain inbound events.** Confirm handlers exist and are idempotent for `procurement.grn.received`, `warehouse.count.session.completed`, `manufacturing.production.completed`, `sales.shipment.picked`, `sales.return.received`. Missing/non-idempotent handlers become I4 backlog items.
4. **UI duplication scan.** After ADR-0079/0080, list any orphan pages/routes/hooks in `src/pages/inventory/**` that duplicate a warehouse or physical-count surface.

### Step 2 — ADR 0081 draft

`docs/adr/0081-inventory-domain-ownership.md`. Decision, boundary contract with Warehouse/Procurement/Sales/Manufacturing, canonical RPC surface, event contracts, non-goals. No migration until this ADR is written.

### Step 3 — Batched execution (I1 → I7)

Each batch ships production-ready in one turn, no orphans, retires legacy in the same migration that supersedes it.

- **I1 — RPC canonicalisation.** Consolidate to: `post_stock_adjustment_atomic`, `post_physical_count_atomic`, `execute_stock_transfer_atomic`, `reserve_stock_atomic`, `release_reservation_atomic`, `revalue_layer_atomic`, `write_off_lot_atomic`. Any pre-existing overloads/legacy names dropped in the same migration; all callers repointed.
- **I2 — Governance duties + SoD.** Register `inventory.adjust.approve`, `inventory.adjust.post`, `inventory.transfer.approve`, `inventory.transfer.execute`, `inventory.revalue.post`, `inventory.count.approve`; SoD conflicts (approver ≠ poster).
- **I3 — Integrity triggers.** DB-level `business_id`/`branch_id` alignment across `stock_movements` ↔ `warehouses` ↔ `stock_locations`; forbid negative `stock_quants` outside sanctioned reversal RPCs.
- **I4 — Event-contract verification.** Idempotent handlers for the five inbound events above; outbox emission on every state change; matching architecture test.
- **I5 — UI consolidation.** Retire orphan inventory pages found in Step 1; every route either lives or 301s.
- **I6 — Architecture guardrails.** New `src/test/architecture/inventory-write-paths.test.ts` forbidding direct writes to `stock_movements` / `stock_quants` / `cost_layers` from anywhere outside the sanctioned RPCs, and forbidding cross-app writers touching inventory tables.
- **I7 — Verdict + close.** `docs/audit/inventory-verdict.md`; update `.lovable/plan.md` marking Phase 3 CLOSED and Phase 4 (Sales / O2C) as next.

### Guardrails (permanent, applied every batch)

- Every new `public` table has `GRANT`s in the same migration.
- Every RPC: `SECURITY DEFINER` + `SET search_path = public` + SoD-guarded + `FOR UPDATE` on the aggregate.
- No client-side writes to ledger/state tables. Cross-app writes go through `business_event_outbox`.
- Party-vs-role universal (no `<entity>_id` FKs where `contacts.id` is correct).
- Legacy retired in the same turn as the replacement.

---

## Deliverables

- `docs/audit/phase-1-2-verification.md` — evidence Phases 1 & 2 are production-grade (or the diffs that made them so).
- `docs/audit/inventory-ownership-map.md` — Step 1 discovery output.
- `docs/adr/0081-inventory-domain-ownership.md`.
- Migrations for I1–I4.
- `src/test/architecture/inventory-write-paths.test.ts` (I6).
- `docs/audit/inventory-verdict.md` (I7).
- Updated `.lovable/plan.md`.

Confirm and I'll start with Step 0 verification, reporting findings before touching any code.