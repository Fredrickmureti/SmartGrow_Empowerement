# Packaging Master (ADR 0105) — implementation status

Authoritative project status for the Carton Catalogue → **Packaging Master**
programme. Update this file at the end of every phase.

**Last updated:** 2026-08-02
**Active phase:** Phase 7 (Packaging Master Workspace) — not started
**Last completed phase:** Phase 6 (Hardware & packaging supply) — verified

---

## Completed and verified

### Phases 1–4 — Packaging Master foundation
- `wms_packaging_types`, `wms_packaging_carriers`, `wms_packaging_availability`,
  `wms_packaging_events` created; writes are RPC-only
  (`wms_packaging_upsert`, `wms_packaging_set_lifecycle`,
  `wms_packaging_archive`, `wms_packaging_set_carrier_rule`,
  `wms_packaging_set_availability`), `row_version` checked, audited, outbox-emitting.
- Cartonization v2 `suggest_packaging`: rotation-aware per-axis fit, fill cap,
  dim weight, hazmat/cold-chain/carrier/stock filters, explainable failure reasons.
- GS1 identity: `wms_gs1_config`, `wms_sscc_registry`, `gs1_check_digit`,
  `wms_sscc_build/is_valid`, `wms_sscc_allocate/void/label_payload`,
  `wms.label.carton` template. SSCC minted server-side only.

### Phase 4.5 — One pack path, hardened privileges
- `MobilePack` repointed from `suggest_carton`/`assign_carton_to_pack` to
  `suggest_packaging`/`assign_packaging_to_pack`.
- Both stations read `open_pack_carton`'s dispatcher envelope `{ carton_id }`
  (mobile previously read a bare string and silently skipped the stamp).
- SSCC client literals aligned to the `wms_sscc_entity` enum (`carton`).
- Write grants revoked from `anon`/`authenticated` on all packaging + SSCC
  tables (defence in depth, guarded).
- `wms_lpn_move` registered in the `wms_replay_guarded_call` dispatcher —
  queued offline plate moves previously failed on drain.

### Phase 5 — Handling-unit unification
- `wms_license_plates.packaging_type_id` (+ filtered index, FK).
- `wms_packaging_class_to_lpn_type` derives the coarse `wms_lpn_type` facet
  server-side; the client never sets it.
- `wms_lpn_set_packaging` (row_version checked, audited on `wms_lpn_events`),
  registered in the replay dispatcher via `_wms_replay_lpn_set_packaging`.
- `trg_wms_pack_carton_propagate_packaging` propagates a carton's packaging
  type to its shipment plate.
- `wms_resolve_carton_scan` resolves SSCC-18 / GS1 `(00)` / plate code to one
  handling unit; PackStation's `pack.carton` scan intent calls it and focuses
  or seals the matching carton.
- Client seam: `src/features/warehouse/packaging/handlingUnitPackaging.ts`.
- PackStation repointed off the legacy `carton_type_id` column.

### Phase 6 — Hardware & packaging supply consumption
- `wms_packaging_consume(...)`: `FOR UPDATE` decrement of
  `wms_packaging_availability`, `consumed` audit row with negative `qty_delta`,
  `warehouse.packaging.consumed` and `warehouse.packaging.reorder_needed`
  outbox events with per-reference idempotency keys. Untracked packaging is a
  no-op. Revoked from PUBLIC — no client call site.
- `seal_pack_carton` consumes exactly one unit, guarded by the new
  `wms_pack_cartons.packaging_consumed_at` stamp and an exception block, so a
  supply problem never blocks a seal. Seal outbox payload now carries
  `packaging_type_id` + consumption result.
- `usePackScale` reads the bound scale through the sanctioned hardware command
  router (`useHardwareProxy` → `resolve_device` → `TransportRouter`),
  normalises g/lb/oz → kg, and surfaces unstable readings. Wired into the
  PackStation seal dialog (Read scale / Tare) with manual entry retained.

**Verification:** 31 guards in `src/test/architecture/packaging-master.test.ts`,
5 unit tests in `src/test/hardware/pack-scale-normalization.test.ts`, plus
`lpn-handling-units`, `wms-phase4b`, `wms-phase12` — 55/55 passing.
`tsgo --noEmit -p tsconfig.app.json` clean.

---

## Pending

### Phase 7 — Packaging Master Workspace (NEXT)
Replace the legacy CRUD table with an enterprise workspace:
- TanStack Table v8 list with faceted filters (class, lifecycle, carrier
  admissibility, stocked/low-stock, hazmat, temperature), virtualized rows.
- Visual inspector: inner/outer dimensions, weight limits, fill cap, dim-weight
  divisor, ti/hi, nesting, returnable, cost.
- Lifecycle rail (`draft → active → restricted → retired`) driven by
  `wms_packaging_set_lifecycle`; archive via `wms_packaging_archive`.
- Carrier admissibility and per-warehouse availability editors calling
  `wms_packaging_set_carrier_rule` / `wms_packaging_set_availability`.
- Audit timeline from `wms_packaging_events`; low-stock surfacing from the
  Phase 6 reorder events.
- Guards: no client table writes, `row_version` sent on every mutation.

### Phase 8 — Decommission legacy
- Drop `wms_carton_types`, `suggest_carton`, `assign_carton_to_pack` and the
  `wms_pack_cartons.carton_type_id` column (after confirming no reader remains).
- Remove the `suggest_carton` branch from `wms_replay_guarded_call`.
- Backfill `packaging_consumed_at` semantics documented; guard that no
  `carton_type` identifier survives anywhere in `src/` or in SQL.

### Deferred / out of scope for now
- Multi-carton bin-packing heuristics (ADR 0083 non-goal, Phase 13).
- Cross-warehouse cross-dock (Phase 14).

---

## Instructions for the next agent

1. **Verify Phase 6 before writing anything new.**
   - `bunx vitest run src/test/architecture/packaging-master.test.ts src/test/hardware/pack-scale-normalization.test.ts`
     and `bunx tsgo --noEmit -p tsconfig.app.json` must be clean.
   - Confirm in the database that `seal_pack_carton` calls
     `wms_packaging_consume` behind the `packaging_consumed_at` guard, that
     `wms_packaging_consume` has no `PUBLIC`/`authenticated` EXECUTE grant, and
     that `wms_pack_cartons.packaging_consumed_at` exists.
   - Confirm no client file references `wms_packaging_consume` and that
     `PackStation` reads weight only through `usePackScale`.
2. **Then continue with Phase 7** (Packaging Master Workspace) — do not pick up
   unrelated work and do not start Phase 8 before Phase 7 is production-ready.
3. Keep the established invariants: server-owned writes, `row_version`
   concurrency, audit row + outbox event per mutation, semantic design tokens
   only, and a guard test for every new invariant.
4. Update this file (status, active phase, next step) as the final step of the
   phase.
